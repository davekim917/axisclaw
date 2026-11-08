import { afterEach, describe, expect, it } from 'bun:test';

import { activateGcpServiceAccount, resetGcpActivationForTesting } from './gcp-auth-setup.js';

const savedKey = process.env.GOOGLE_APPLICATION_CREDENTIALS;

afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedKey;
  resetGcpActivationForTesting();
});

describe('activateGcpServiceAccount', () => {
  it('runs once per process, so the full boot does not repeat what the early task gate did', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/gcp-key-for-test.json';
    const logs: string[] = [];

    activateGcpServiceAccount((m) => logs.push(m));
    activateGcpServiceAccount((m) => logs.push(m));

    expect(logs).toEqual([
      'gcloud: GOOGLE_APPLICATION_CREDENTIALS=/nonexistent/gcp-key-for-test.json not found — skipping activation',
    ]);
  });
});
