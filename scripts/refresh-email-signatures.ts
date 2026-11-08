import { recordSignatureRefresh, refreshEmailSignatures } from '../src/modules/email-signatures/refresh.js';

const result = await refreshEmailSignatures();
recordSignatureRefresh(result);
console.log(
  `written: ${result.written.join(', ') || '-'}\ncleared (no signature): ${result.cleared.join(', ') || '-'}\nfailed (copy unchanged): ${result.failed.join(', ') || '-'}`,
);
process.exitCode = result.failed.length ? 1 : 0;
