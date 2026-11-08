import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { readDeliveredRow } from '../modules/mailbox/index.js';
import { isAllowedFilePath } from './core.js';
import { registerTools } from './server.js';
import { err, generateId, log, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

// Longer than the host's own Slack request timeout, so whatever the host decides is answered within the call.
const DECISION_WAIT_MS = 90_000;
const POLL_MS = 300;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The host's answer to one request: sent, refused, or waiting on a card. */
async function awaitDecision(requestId: string) {
  const deadline = Date.now() + DECISION_WAIT_MS;
  for (;;) {
    const row = readDeliveredRow(requestId);
    if (row?.status === 'delivered')
      return ok(`Done. Slack id ${row.platform_message_id ?? '(none)'}; request ${requestId}.`);
    if (row && row.status !== 'pending') return err(row.error ?? 'refused by the host');
    if (row?.status === 'pending') {
      return ok(
        `A card showing exactly this is waiting for approval (request ${requestId}). The result arrives as a message; do not send it any other way meanwhile.`,
      );
    }
    if (Date.now() >= deadline) {
      return ok(
        `Submitted (request ${requestId}); the host has not answered yet. Check the channel before asking again.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const channelProp = {
  type: 'string',
  description: 'Slack channel or DM id: the C…, G… or D… id from its link or conversations.list.',
};
const threadProp = { type: 'string', description: 'Parent message ts to reply in its thread, e.g. 1712345678.123456.' };

export const postAsOwner: McpToolDefinition = {
  tool: {
    name: 'post_as_owner',
    description:
      'Post, or edit, a Slack message in the owner\'s own name. This is the only way to write to Slack as the owner here; raw chat.* and files.* calls are refused. The host sends exactly `text`, once. A card shows the exact text and destination to approve (in this thread, or in the owner\'s DM from a background task), and the result arrives as a message. Deleting messages and reactions are not available: ask the owner.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: channelProp,
        text: { type: 'string', description: 'The message, exactly as it should appear (Slack mrkdwn).' },
        thread_ts: threadProp,
        edit_ts: { type: 'string', description: "To edit instead of post: the ts of the owner's message to replace." },
      },
      required: ['channel', 'text'],
    },
  },
  async handler(args) {
    const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!channel || !text.trim()) return err('channel and text are required');
    const requestId = generateId();
    const edit = typeof args.edit_ts === 'string' && args.edit_ts ? args.edit_ts : undefined;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_post_as_owner',
        requestId,
        op: edit ? 'update' : 'post',
        channel,
        text,
        ...(edit ? { ts: edit } : {}),
        ...(typeof args.thread_ts === 'string' && args.thread_ts ? { threadTs: args.thread_ts } : {}),
      }),
    });
    log(`post_as_owner: ${requestId} → ${channel}${edit ? ` (edit ${edit})` : ''}`);
    return awaitDecision(requestId);
  },
};

export const uploadAsOwner: McpToolDefinition = {
  tool: {
    name: 'upload_as_owner',
    description:
      "Upload a file to Slack in the owner's own name. Always shows a card with the file name, size, destination and comment to approve first; the result arrives as a message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: channelProp,
        file: { type: 'string', description: 'Path to the file in your workspace.' },
        comment: { type: 'string', description: 'Optional message posted with the file, exactly as it should appear.' },
        title: { type: 'string', description: 'Optional file title.' },
        thread_ts: threadProp,
      },
      required: ['channel', 'file'],
    },
  },
  async handler(args) {
    const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
    const filePath = typeof args.file === 'string' ? args.file : '';
    if (!channel || !filePath) return err('channel and file are required');
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      return err(`File not found: ${filePath}`);
    }
    if (!isAllowedFilePath(real))
      return err('That path cannot be uploaded; copy the file into /workspace/agent first.');
    const size = fs.statSync(real).size;
    if (size === 0) return err('File is empty.');
    if (size > MAX_FILE_BYTES) return err(`File is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const requestId = generateId();
    const name = path.basename(real);
    const outbox = path.join('/workspace/outbox', requestId);
    fs.mkdirSync(outbox, { recursive: true });
    fs.copyFileSync(real, path.join(outbox, name));
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_post_as_owner',
        requestId,
        op: 'upload',
        channel,
        file: name,
        text: typeof args.comment === 'string' ? args.comment : '',
        ...(typeof args.title === 'string' && args.title ? { title: args.title } : {}),
        ...(typeof args.thread_ts === 'string' && args.thread_ts ? { threadTs: args.thread_ts } : {}),
      }),
    });
    log(`upload_as_owner: ${requestId} → ${channel} (${name}, ${size} bytes)`);
    return awaitDecision(requestId);
  },
};

registerTools([postAsOwner, uploadAsOwner]);
