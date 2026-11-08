import { parentPort } from 'node:worker_threads';

import { provenDisposable } from './checkout-proof.js';

export interface CheckoutProofRequest {
  path: string;
  inheritedTags: ReadonlyMap<string, string> | null;
}

export interface CheckoutProof {
  ok: boolean;
  reason: string;
}

const port = parentPort;
if (!port) throw new Error('Checkout proof worker requires a parent port');

port.on('message', ({ path, inheritedTags }: CheckoutProofRequest) => {
  port.postMessage(provenDisposable(path, 'all', inheritedTags, true) satisfies CheckoutProof);
});
