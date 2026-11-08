import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/** Every non-test source file under `src/`, by its path from the repo root. */
function sources(dir = 'src'): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(at);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [at] : [];
  });
}

const callersOf = (call: RegExp) =>
  sources()
    .filter((file) => call.test(fs.readFileSync(file, 'utf8')))
    .sort();

// The files methods carry a person's own token, or a group's token as that person. Only a file the person picked in
// the app and sent with their device's send key may reach them, so nothing an agent starts can.
describe('what reaches a person’s files methods', () => {
  it('shares files only from the Slack target of the app’s reply route, and takes uploads only in that route', () => {
    expect(callersOf(/\.shareFiles\(/)).toEqual([path.join('src', 'modules', 'mobile', 'slack-send.ts')]);
    expect(callersOf(/(?<!function )\btakeUploads\(/)).toEqual([path.join('src', 'modules', 'mobile', 'http.ts')]);
  });
});
