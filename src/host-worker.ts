import { fileURLToPath } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';

/** Starts `<entry>.js`, or `<entry>.ts` when the host itself runs from source; `entry` resolves against `parentUrl`. */
export function startHostWorker(entry: string, parentUrl: string, options: WorkerOptions = {}): Worker {
  // Never inherit parent-only flags such as `--input-type=module`: Node rejects them for a file-URL Worker.
  const workerOptions = { ...options, execArgv: [] };
  if (!parentUrl.endsWith('.ts')) return new Worker(new URL(`${entry}.js`, parentUrl), workerOptions);
  // Node does not apply `--import tsx` hooks to a file-backed Worker, so tsx is registered inside an eval bootstrap.
  const entryPath = fileURLToPath(new URL(`${entry}.ts`, parentUrl));
  const parentPath = fileURLToPath(parentUrl);
  const bootstrap = `const { require: tsxRequire } = require('tsx/cjs/api'); tsxRequire(${JSON.stringify(entryPath)}, ${JSON.stringify(parentPath)});`;
  return new Worker(bootstrap, { ...workerOptions, eval: true });
}
