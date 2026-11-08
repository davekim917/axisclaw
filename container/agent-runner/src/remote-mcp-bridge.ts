#!/usr/bin/env bun
/** stdio-to-Streamable-HTTP MCP bridge, so stdio-only runtimes reach OneCLI-proxied HTTP MCPs without holding credentials. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CallToolRequest,
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { appendLedgerEntry } from './source-ledger.js';

const DEFAULT_VERSION = '1.0.0';

function log(msg: string): void {
  // MCP protocol uses stdout; logs go to stderr.
  console.error(`[remote-mcp-bridge] ${msg}`);
}

function remoteName(): string {
  return process.env.REMOTE_MCP_NAME || 'remote';
}

function remoteUrl(): string {
  const url = process.argv[2] || process.env.REMOTE_MCP_URL;
  if (!url) {
    throw new Error('remote MCP URL required as argv[2] or REMOTE_MCP_URL');
  }
  return url;
}

/** The full validated header map, not just Authorization: dropping the rest silently narrows what the CLI validated. */
export function requestHeaders(): HeadersInit | undefined {
  const raw = process.env.REMOTE_MCP_HEADERS;
  if (!raw) return undefined;
  let headers: unknown;
  try {
    headers = JSON.parse(raw);
  } catch (err) {
    throw new Error(`REMOTE_MCP_HEADERS is not valid JSON: ${errorText(err)}`);
  }
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error('REMOTE_MCP_HEADERS must be a JSON object with string values');
  }
  return Object.keys(headers).length > 0 ? (headers as Record<string, string>) : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One tool call on the remote, with `timeoutMs` in place of the MCP SDK's 60-second default when it is given. */
export async function callRemoteTool(
  client: Pick<Client, 'callTool'>,
  params: CallToolRequest['params'],
  timeoutMs?: number,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  try {
    return await client.callTool(params, undefined, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Remote MCP error: ${errorText(err)}` }],
      isError: true,
    };
  }
}

/**
 * Records one call of a bridged data source. `origin` is the system the bridge itself was configured to reach, so the
 * host can refuse a footer for any system other than the group's own.
 */
export function recordSourceCall(
  source: { server: string; origin: string },
  params: CallToolRequest['params'],
  isError: boolean,
): void {
  appendLedgerEntry({
    v: 1,
    ts: new Date().toISOString(),
    recorder: 'mcp',
    server: source.server,
    origin: source.origin,
    tool: params.name,
    args: params.arguments ?? {},
    ok: !isError,
  });
}

/** Serves `url`'s Streamable-HTTP MCP on this process's stdio until a signal ends it. */
export async function bridgeStdioTo(
  name: string,
  url: string,
  headers: HeadersInit | undefined,
  callTimeoutMs?: number,
  /** Set only for a data source whose calls a reply's sources footer may name. */
  source?: { origin: string },
): Promise<void> {
  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const client = new Client({ name: `${name}-stdio-bridge`, version: DEFAULT_VERSION });

  await client.connect(httpTransport);
  const caps = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name, version: client.getServerVersion()?.version ?? DEFAULT_VERSION },
    {
      capabilities: {
        ...(caps.tools ? { tools: {} } : {}),
        ...(caps.resources
          ? { resources: { subscribe: false, listChanged: Boolean(caps.resources.listChanged) } }
          : {}),
        ...(caps.prompts ? { prompts: { listChanged: Boolean(caps.prompts.listChanged) } } : {}),
        ...(caps.completions ? { completions: {} } : {}),
      },
    },
  );

  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => client.listTools(request.params));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await callRemoteTool(client, request.params, callTimeoutMs);
      if (source) recordSourceCall({ server: name, origin: source.origin }, request.params, result.isError === true);
      return result;
    });
  }

  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => client.listResources(request.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
      client.listResourceTemplates(request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => client.readResource(request.params));
  }

  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => client.listPrompts(request.params));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => client.getPrompt(request.params));
  }

  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => client.complete(request.params));
  }

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  process.once('SIGTERM', () => {
    void httpTransport.close().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void httpTransport.close().finally(() => process.exit(0));
  });

  log(`${name} bridge ready (${url})`);
}

async function main(): Promise<void> {
  if (!process.env.HTTPS_PROXY) {
    log('WARN: HTTPS_PROXY not set — remote MCP calls may go out unauthenticated');
  }
  await bridgeStdioTo(remoteName(), remoteUrl(), requestHeaders());
}

if (import.meta.main) {
  main().catch((err) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
