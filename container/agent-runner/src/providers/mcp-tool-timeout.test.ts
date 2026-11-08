import { describe, expect, it } from 'bun:test';

import { renderCodexMcpServer } from './codex-app-server.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

const BAD: Array<[string, unknown]> = [
  ['a string', 'abc'],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a negative number', -5],
  ['zero', 0],
  ['a fraction of a second', 500],
  ['a fractional millisecond count', 1500.5],
  ['more than a day', 2 * 24 * 60 * 60 * 1000],
];

describe('an unusable MCP tool timeout', () => {
  it.each(BAD)('is left out of the Codex config when it is %s', (_name, timeout) => {
    const lines = renderCodexMcpServer('x', { type: 'stdio', command: 'bun', timeout: timeout as number });
    expect(lines.join('\n')).not.toContain('tool_timeout_sec');
  });

  it.each(BAD)('is left out of the OpenCode config when it is %s', (_name, timeout) => {
    const mcp = mcpServersToOpenCodeConfig({ x: { command: 'bun', timeout: timeout as number } });
    expect(mcp.x).not.toHaveProperty('timeout');
  });
});
