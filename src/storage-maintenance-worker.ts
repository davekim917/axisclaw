import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { startHostWorker } from './host-worker.js';
import {
  createStorageStatusReport,
  resolveStoragePolicy,
  type FilesystemUsage,
  type StorageAdmissionResult,
  type StorageReport,
  type StorageReportOptions,
} from './storage-manager.js';
import { clearStorageCleanupClaims } from './storage-activity.js';

// Both omitted members are functions, which cannot cross the worker boundary.
type SerializableStorageOptions = Omit<StorageReportOptions, 'isContainerRunning' | 'runningContainerMounts'>;
type StorageWorkerCommand = 'maintenance' | 'admission' | 'report';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface WorkerLike {
  on(event: 'message', listener: (message: StorageWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
}

interface StorageWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type StorageWorkerFactory = () => WorkerLike;

function createWorker(): WorkerLike {
  return startHostWorker('./storage-maintenance-worker-thread', import.meta.url, {
    workerData: { dbPath: path.join(DATA_DIR, 'v2.db') },
  });
}

/** One persistent worker (keeps cadence state); all filesystem, SQLite and Docker work runs off the host's loop. */
export class BackgroundStorageMaintenance {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopped = false;
  private maintenanceInFlight: Promise<StorageReport> | null = null;

  constructor(private readonly workerFactory: StorageWorkerFactory = createWorker) {}

  runMaintenance(activeSessionIds: string[]): Promise<StorageReport | null> {
    if (this.maintenanceInFlight) return Promise.resolve(null);
    const request = this.request<StorageReport>('maintenance', activeSessionIds, { respectCadence: true });
    this.maintenanceInFlight = request;
    const clear = () => {
      if (this.maintenanceInFlight === request) this.maintenanceInFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  assertAdmission(activeSessionIds: string[]): Promise<StorageAdmissionResult> {
    return this.request<StorageAdmissionResult>('admission', activeSessionIds);
  }

  getReport(activeSessionIds: string[], options: SerializableStorageOptions): Promise<StorageReport> {
    return this.request<StorageReport>('report', activeSessionIds, options);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    this.worker = null;
    this.failPending(new Error('Storage maintenance worker stopped'));
    if (worker) await worker.terminate();
    clearStorageCleanupClaims();
  }

  private request<T>(
    command: StorageWorkerCommand,
    activeSessionIds: string[],
    options?: SerializableStorageOptions,
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Storage maintenance worker is stopped'));
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        worker.postMessage({ id, command, activeSessionIds, options });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.on('message', (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? 'Storage maintenance worker failed'));
    });
    worker.on('error', (error) => this.handleWorkerFailure(worker, error));
    worker.on('exit', (code) => {
      if (!this.stopped) {
        this.handleWorkerFailure(worker, new Error(`Storage maintenance worker exited ${code}`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private handleWorkerFailure(worker: WorkerLike, error: Error): void {
    // A failed Worker emits `error` then `exit`; ignore the late exit once a replacement exists.
    if (this.worker !== worker) return;
    this.worker = null;
    this.maintenanceInFlight = null;
    this.failPending(error);
    clearStorageCleanupClaims();
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

const backgroundStorageMaintenance = new BackgroundStorageMaintenance();

async function getFilesystemUsageAsync(targetPath: string): Promise<FilesystemUsage | null> {
  let probePath = targetPath;
  try {
    await fs.promises.access(probePath);
  } catch {
    probePath = process.cwd();
  }

  try {
    const stats = await fs.promises.statfs(probePath);
    const sizeBytes = stats.blocks * stats.bsize;
    const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usableBytes = usedBytes + availableBytes;
    if (![sizeBytes, usedBytes, availableBytes, usableBytes].every(Number.isFinite) || usableBytes <= 0) return null;
    return {
      path: targetPath,
      sizeBytes,
      usedBytes,
      availableBytes,
      // Match `df`'s whole-percent, round-up behavior at policy boundaries.
      usagePct: Math.ceil((usedBytes / usableBytes) * 100),
    };
  } catch {
    return null;
  }
}

export function runStorageMaintenanceInBackground(activeSessionIds: string[]): Promise<StorageReport | null> {
  return backgroundStorageMaintenance.runMaintenance(activeSessionIds);
}

export async function assertStorageAdmissionInBackground(activeSessionIds: string[]): Promise<StorageAdmissionResult> {
  const policy = resolveStoragePolicy();
  const usage = policy.enabled ? await getFilesystemUsageAsync(policy.filesystemPath) : null;
  if (!policy.enabled) {
    return {
      allowed: true,
      reason: 'disabled',
      report: createStorageStatusReport(policy, null, Date.now(), [
        'storage manager disabled by NANOCLAW_STORAGE_MANAGER_ENABLED=0',
      ]),
    };
  }
  if (!usage) {
    return {
      allowed: true,
      reason: 'usage-unavailable',
      report: createStorageStatusReport(policy, null, Date.now(), ['async filesystem usage probe unavailable']),
    };
  }
  if (usage.usagePct < policy.cleanupThresholdPct) {
    return {
      allowed: true,
      reason: 'below-threshold',
      report: createStorageStatusReport(policy, usage),
    };
  }
  // The worker answers one message at a time, so a queued admission waits out a whole maintenance pass. Below the
  // refuse line that wait can only end in "allowed"; the hourly pass still does the cleanup.
  if (usage.usagePct < policy.admissionRefusePct) {
    return {
      allowed: true,
      reason: 'below-refuse-threshold',
      report: createStorageStatusReport(policy, usage),
    };
  }

  // Only usage that could be refused enters the serialized queue, so a refusal observes a running pass instead of racing it.
  return backgroundStorageMaintenance.assertAdmission(activeSessionIds);
}

export function getStorageReportInBackground(
  activeSessionIds: string[],
  options: SerializableStorageOptions,
): Promise<StorageReport> {
  return backgroundStorageMaintenance.getReport(activeSessionIds, options);
}

export function stopStorageMaintenanceWorker(): Promise<void> {
  return backgroundStorageMaintenance.close();
}
