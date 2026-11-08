import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { callRemoteTool, requestHeaders } from './remote-mcp-bridge.js';

describe('callRemoteTool', () => {
  async function clientOfASlowTool(delayMs: number): Promise<Client> {
    const server = new Server({ name: 'slow', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      await Bun.sleep(delayMs);
      return { content: [{ type: 'text' as const, text: 'done' }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it('waits as long as the timeout it is given', async () => {
    const client = await clientOfASlowTool(100);
    const result = await callRemoteTool(client, { name: 'x' }, 2_000);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
  });

  it('reports a call past its timeout as a tool error', async () => {
    const client = await clientOfASlowTool(200);
    const result = await callRemoteTool(client, { name: 'x' }, 20);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Remote MCP error: .*timed out/i);
  });
});

/**
 * `main()` is guarded by `import.meta.main` (only runs when this file is the
 * process entry point, e.g. `bun remote-mcp-bridge.ts <url>`), so importing
 * it here to test `requestHeaders` does not open a network connection.
 */
describe('requestHeaders', () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot.REMOTE_MCP_HEADERS = process.env.REMOTE_MCP_HEADERS;
    delete process.env.REMOTE_MCP_HEADERS;
  });

  afterEach(() => {
    if (snapshot.REMOTE_MCP_HEADERS === undefined) delete process.env.REMOTE_MCP_HEADERS;
    else process.env.REMOTE_MCP_HEADERS = snapshot.REMOTE_MCP_HEADERS;
  });

  it('returns undefined when REMOTE_MCP_HEADERS is unset', () => {
    expect(requestHeaders()).toBeUndefined();
  });

  it('forwards the full header map, not just Authorization', () => {
    // Round 5 finding: codex.ts:1017-1024 used to extract only Authorization
    // into a single env var; a server declared with X-Api-Version or a
    // custom OneCLI-managed placeholder header had every other header
    // silently dropped by this bridge.
    process.env.REMOTE_MCP_HEADERS = JSON.stringify({
      Authorization: 'Bearer onecli-managed',
      'X-Api-Version': '2024-01-01',
      'X-Custom': 'onecli-managed',
    });
    expect(requestHeaders()).toEqual({
      Authorization: 'Bearer onecli-managed',
      'X-Api-Version': '2024-01-01',
      'X-Custom': 'onecli-managed',
    });
  });

  it('returns undefined for an empty header object', () => {
    process.env.REMOTE_MCP_HEADERS = '{}';
    expect(requestHeaders()).toBeUndefined();
  });

  it('throws on malformed JSON rather than silently dropping headers', () => {
    process.env.REMOTE_MCP_HEADERS = '{not-json';
    expect(() => requestHeaders()).toThrow(/not valid JSON/);
  });

  it('throws when REMOTE_MCP_HEADERS is not a JSON object', () => {
    process.env.REMOTE_MCP_HEADERS = '["a", "b"]';
    expect(() => requestHeaders()).toThrow(/must be a JSON object/);
    process.env.REMOTE_MCP_HEADERS = '"just a string"';
    expect(() => requestHeaders()).toThrow(/must be a JSON object/);
  });
});
