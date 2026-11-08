/**
 * The two READ-ONLY session funnels for operator surfaces (the dashboard fans
 * out across every session in the fleet). Not `withExistingMailboxSession` or
 * the read-write openers: those open inbound.db read-write, run migrations
 * (DDL) on first touch, set journal_mode (a header write) and plant a
 * reclaim-blocking marker, and a console poll must never write to or migrate a
 * session it is only listing. Opens are `readonly` with a 1s busy_timeout so a
 * slow session degrades to `unreadable` instead of stalling the console.
 *
 * Shared with the read-write funnels: the failure classification. A gone file
 * answers `undefined`; a present-but-unreadable one THROWS, so it is counted
 * unreadable rather than reported healthy-and-empty. Synchronous by design.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getContainerState, getProcessingClaims, type ContainerState, type ProcessingClaim } from './ops/sweep.js';
import { resolveInboundDbPath } from './host-inbound.js';
import { inboundHasMessage } from './ops/ingress.js';
import {
  countLiveSeriesRows,
  type DeliveredPost,
  getLatestSeriesRow,
  getLatestTaskDeliveryRoute,
  getLatestTaskEvent,
  getLatestTaskRoutingStamp,
  getLatestTaskRow,
  getLiveSeriesRow,
  getTaskRowById,
  getLiveTaskRow,
  getLiveTaskRowById,
  hasPendingRecurrence,
  hasTriggeredInboundRow,
  hasWorkContinuation,
  latestInboundMessageId,
  latestReplyTimestampByTrigger,
  listDeliveredSince,
  listDuplicateLiveTaskSeriesIds,
  listInboundFeed,
  listInboundHead,
  listInboundTail,
  listLatestRecurringSeriesRows,
  listLiveOneOffTaskRows,
  listLiveTaskRows,
  listLiveTaskRowsForSeries,
  listOutboundFeed,
  listOutboundChatHead,
  listOutboundTail,
  listProcessingClaimedMessageIds,
  listRecentTaskFires,
  listTurnUsageSince,
  type MessageFeedRow,
  type MessageTailRow,
  type ScheduledTaskRow,
  type SessionTurnUsageRow,
  type TaskDeliveryRoute,
  type TaskEvent,
  type TaskFireRow,
  type TaskRoutingStamp,
} from './ops/reads.js';
import { hasMoveCancellationReceipt } from './ops/tasks.js';
import {
  assertQueryable,
  asMissingDbError,
  recoverHotJournal,
  SessionDbMissingError,
  sessionDbPathIsGone,
} from './openers.js';

/**
 * `dataDir` overrides `DATA_DIR` (a constant with no env override) so test
 * fixture roots never touch the live install. Production callers omit it.
 */
export interface SessionReadLocation {
  agentGroupId: string;
  sessionId: string;
  dataDir?: string;
}

export interface SessionReadOptions {
  /**
   * Defaults to 1s so a contended session degrades to `unreadable` on a fleet
   * fan-out; single-session callers pass the write path's 5000.
   */
  busyTimeoutMs?: number;
  /**
   * Roll a hot journal back first. A rollback is a WRITE, so it is off by
   * default. Pass it only when replacing an opener that already recovered
   * journals; never on a read-only caller or fleet fan-out.
   */
  recoverJournal?: boolean;
}

export interface InboundSessionRead {
  inboundHasMessage(messageId: string): boolean;
  listDuplicateLiveTaskSeriesIds(): string[];
  listLatestRecurringSeriesRows(): ScheduledTaskRow[];
  listLiveOneOffTaskRows(): ScheduledTaskRow[];
  listLiveTaskRows(): ScheduledTaskRow[];
  listLiveTaskRowsForSeries(seriesId: string): ScheduledTaskRow[];
  getLiveSeriesRow(seriesId: string): ScheduledTaskRow | null;
  getLatestSeriesRow(seriesId: string): ScheduledTaskRow | null;
  getLiveTaskRow(seriesId: string): ScheduledTaskRow | null;
  getLiveTaskRowById(rowId: string): ScheduledTaskRow | null;
  getTaskRowById(rowId: string): ScheduledTaskRow | null;
  hasMoveCancellationReceipt(receiptId: string): boolean;
  getLatestTaskRow(seriesId: string): ScheduledTaskRow | null;
  listRecentTaskFires(seriesId: string, limit: number): TaskFireRow[];
  latestInboundMessageId(): string | null;
  listDeliveredSince(since: string, limit: number): DeliveredPost[];
  hasPendingRecurrence(): boolean;
  hasTriggeredInboundRow(): boolean;
  listInboundHead(limit: number): MessageTailRow[];
  listInboundTail(limit: number): MessageTailRow[];
  listInboundFeed(afterSeq: number | null, limit: number): MessageFeedRow[];
  countLiveSeriesRows(seriesId: string): number;
  getLatestTaskRoutingStamp(seriesId: string): TaskRoutingStamp | null;
  getLatestTaskDeliveryRoute(): TaskDeliveryRoute | null;
  getLatestTaskEvent(): TaskEvent | null;
}

export interface OutboundSessionRead {
  getContainerState(): ContainerState | null;
  getProcessingClaimRows(): ProcessingClaim[];
  listProcessingClaimedMessageIds(): string[];
  hasWorkContinuation(): boolean;
  latestReplyTimestampByTrigger(): Map<string, string>;
  listTurnUsageSince(afterId: number): SessionTurnUsageRow[];
  listOutboundChatHead(limit: number, threadId: string | null): MessageTailRow[];
  listOutboundTail(limit: number): MessageTailRow[];
  listOutboundFeed(afterSeq: number | null, limit: number): MessageFeedRow[];
}

/**
 * The resolved path must be EXACTLY
 * `<dataDir>/v2-sessions/<agentGroupId>/<sessionId>/<side>.db`, strictly inside
 * the base; anything else is not a session (`null` = "no mailbox").
 */
function resolveReadPath(location: SessionReadLocation, side: 'inbound' | 'outbound'): string | null {
  const base = path.resolve(location.dataDir ?? DATA_DIR, 'v2-sessions');
  const resolved = path.resolve(base, location.agentGroupId, location.sessionId);
  const expected = path.join(base, location.agentGroupId, location.sessionId);
  if (resolved !== expected || !resolved.startsWith(base + path.sep)) return null;
  // Containment is checked on the session dir (built from caller ids); the
  // `.host` segment is appended by our own resolver, never by an id.
  return side === 'inbound' ? resolveInboundDbPath(resolved) : path.join(resolved, 'outbound.db');
}

/**
 * Same failure classification as the read-write funnels (`assertQueryable`),
 * but never the part that writes: hot-journal recovery is opt-in via
 * `recoverJournal`.
 */
function openRead(dbPath: string, options: SessionReadOptions): Database.Database {
  if (options.recoverJournal) recoverHotJournal(dbPath);
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 1000}`);
  } catch (err) {
    // better-sqlite3 opens eagerly, so mode-000 or descriptor exhaustion fails
    // here; classify it the same way.
    db?.close();
    throw asMissingDbError(err, dbPath);
  }
  assertQueryable(db, dbPath);
  return db;
}

/** Closes the race where the file vanishes after the pre-check: still absence. A present-but-unopenable DB throws. */
function openReadOrAbsent(dbPath: string, options: SessionReadOptions): Database.Database | undefined {
  try {
    return openRead(dbPath, options);
  } catch (err) {
    if (err instanceof SessionDbMissingError) return undefined;
    throw err;
  }
}

/**
 * `undefined` means ABSENT, and only absent: a present-but-unreadable file
 * throws, so a broken session is never reported as an empty one.
 */
export function readSessionInbound<T>(
  location: SessionReadLocation,
  action: (session: InboundSessionRead) => T,
  options: SessionReadOptions = {},
): T | undefined {
  const dbPath = resolveReadPath(location, 'inbound');
  if (dbPath === null || sessionDbPathIsGone(dbPath)) return undefined;
  const db = openReadOrAbsent(dbPath, options);
  if (!db) return undefined;
  try {
    return action({
      inboundHasMessage: (messageId) => inboundHasMessage(db, messageId),
      listDuplicateLiveTaskSeriesIds: () => listDuplicateLiveTaskSeriesIds(db),
      listLatestRecurringSeriesRows: () => listLatestRecurringSeriesRows(db),
      listLiveOneOffTaskRows: () => listLiveOneOffTaskRows(db),
      listLiveTaskRows: () => listLiveTaskRows(db),
      listLiveTaskRowsForSeries: (seriesId) => listLiveTaskRowsForSeries(db, seriesId),
      getLiveSeriesRow: (seriesId) => getLiveSeriesRow(db, seriesId),
      getLatestSeriesRow: (seriesId) => getLatestSeriesRow(db, seriesId),
      getLiveTaskRow: (seriesId) => getLiveTaskRow(db, seriesId),
      getLiveTaskRowById: (rowId) => getLiveTaskRowById(db, rowId),
      getTaskRowById: (rowId) => getTaskRowById(db, rowId),
      hasMoveCancellationReceipt: (receiptId) => hasMoveCancellationReceipt(db, receiptId),
      getLatestTaskRow: (seriesId) => getLatestTaskRow(db, seriesId),
      listRecentTaskFires: (seriesId, limit) => listRecentTaskFires(db, seriesId, limit),
      latestInboundMessageId: () => latestInboundMessageId(db),
      listDeliveredSince: (since, limit) => listDeliveredSince(db, since, limit),
      hasPendingRecurrence: () => hasPendingRecurrence(db),
      hasTriggeredInboundRow: () => hasTriggeredInboundRow(db),
      listInboundHead: (limit) => listInboundHead(db, limit),
      listInboundTail: (limit) => listInboundTail(db, limit),
      listInboundFeed: (afterSeq, limit) => listInboundFeed(db, afterSeq, limit),
      countLiveSeriesRows: (seriesId) => countLiveSeriesRows(db, seriesId),
      getLatestTaskRoutingStamp: (seriesId) => getLatestTaskRoutingStamp(db, seriesId),
      getLatestTaskDeliveryRoute: () => getLatestTaskDeliveryRoute(db),
      getLatestTaskEvent: () => getLatestTaskEvent(db),
    });
  } finally {
    db.close();
  }
}

export function readSessionOutbound<T>(
  location: SessionReadLocation,
  action: (session: OutboundSessionRead) => T,
  options: SessionReadOptions = {},
): T | undefined {
  const dbPath = resolveReadPath(location, 'outbound');
  if (dbPath === null || sessionDbPathIsGone(dbPath)) return undefined;
  const db = openReadOrAbsent(dbPath, options);
  if (!db) return undefined;
  try {
    return action({
      getContainerState: () => getContainerState(db),
      getProcessingClaimRows: () => getProcessingClaims(db),
      listProcessingClaimedMessageIds: () => listProcessingClaimedMessageIds(db),
      hasWorkContinuation: () => hasWorkContinuation(db),
      latestReplyTimestampByTrigger: () => latestReplyTimestampByTrigger(db),
      listTurnUsageSince: (afterId) => listTurnUsageSince(db, afterId),
      listOutboundChatHead: (limit, threadId) => listOutboundChatHead(db, limit, threadId),
      listOutboundTail: (limit) => listOutboundTail(db, limit),
      listOutboundFeed: (afterSeq, limit) => listOutboundFeed(db, afterSeq, limit),
    });
  } finally {
    db.close();
  }
}
