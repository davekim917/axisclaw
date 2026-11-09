import fs from 'node:fs';

const ANCESTRY_DEPTH = 6;

// A script run by one of these is named by the script, not the interpreter.
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);

/**
 * The program each process runs, never its arguments: an argument (a `bash -c` body above all) can carry a
 * credential, and this list is posted to the owner.
 */
function programOf(argv: string[]): string {
  const base = (word: string) => word.slice(word.lastIndexOf('/') + 1);
  const [program = '', script] = argv;
  return INTERPRETERS.has(base(program)) && script && !script.startsWith('-')
    ? `${base(program)} ${base(script)}`
    : base(program);
}

/** The program `pid` and each ancestor run, nearest first; empty where /proc cannot be read. */
export function processAncestry(pid: number, procRoot = '/proc'): string[] {
  const lines: string[] = [];
  for (let current = pid, depth = 0; current > 1 && depth < ANCESTRY_DEPTH; depth++) {
    try {
      const argv = fs.readFileSync(`${procRoot}/${current}/cmdline`, 'utf8').split('\0').filter(Boolean);
      lines.push(`${current}: ${programOf(argv)}`);
      // The comm field sits in parentheses and may itself contain spaces or parentheses.
      const stat = fs.readFileSync(`${procRoot}/${current}/stat`, 'utf8');
      current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a process can exit mid-walk; the ancestry is best effort
    } catch {
      break;
    }
  }
  return lines;
}
