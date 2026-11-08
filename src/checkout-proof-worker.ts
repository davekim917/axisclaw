import { startHostWorker } from './host-worker.js';
import { log } from './log.js';
import type { CheckoutProof, CheckoutProofRequest } from './checkout-proof-worker-thread.js';

interface ProofWorker {
  on(event: 'message', listener: (proof: CheckoutProof) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(request: CheckoutProofRequest): void;
  terminate(): Promise<number>;
  unref(): void;
}

export type ProofWorkerStarter = () => ProofWorker;

export interface CheckoutProofs {
  /** `null` means no answer: the caller proves it the old way, on the main thread. Takes one request at a time. */
  prove(request: CheckoutProofRequest): Promise<CheckoutProof | null>;
  close(): void;
}

const startProofWorker: ProofWorkerStarter = () => startHostWorker('./checkout-proof-worker-thread', import.meta.url);

/** One lazily started worker for a cleanup pass. Git's own timeouts bound a proof, so no timeout here. */
export function openCheckoutProofs(start: ProofWorkerStarter = startProofWorker): CheckoutProofs {
  let worker: ProofWorker | null = null;
  let finished = false;
  let answer: ((proof: CheckoutProof | null) => void) | null = null;

  const settle = (proof: CheckoutProof | null): void => {
    answer?.(proof);
    answer = null;
  };
  const fail = (reason: string): void => {
    if (finished) return;
    finished = true;
    log.warn('Worktree cleanup: proof worker failed; proving on the main thread for the rest of this pass', { reason });
    settle(null);
  };

  return {
    prove(request) {
      if (finished) return Promise.resolve(null);
      return new Promise((resolve) => {
        answer = resolve;
        try {
          if (!worker) {
            worker = start();
            worker.unref();
            worker.on('message', settle);
            worker.on('error', (error) => fail(error.message));
            worker.on('exit', (code) => fail(`worker exited ${code}`));
          }
          worker.postMessage(request);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      });
    },
    close() {
      finished = true;
      settle(null);
      void worker?.terminate();
    },
  };
}
