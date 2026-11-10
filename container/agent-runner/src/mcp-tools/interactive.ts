/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { awaitDeliveryAck } from '../db/delivery-acks.js';
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, inheritedThreadFor } from '../db/session-routing.js';
import { CARD_SPEC_GUIDE } from './card-guide.generated.js';
import { chatSendDenial } from './core.js';
import { registerTools } from './server.js';
import { err, generateId, log, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

function routing() {
  const session = getSessionRouting();
  return { ...session, thread_id: session.platform_id ? inheritedThreadFor(session.platform_id) : session.thread_id };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires, so reach for it only when you genuinely cannot proceed without the decision. For free-text input, send a normal message and wait for their reply instead. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Write question card to outbound.db
    await writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

const SEND_CARD_ACK_TIMEOUT_MS = 30_000;

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: CARD_SPEC_GUIDE,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spec: { type: 'object', description: 'The card: { root, elements }, built from the components above' },
        fallbackText: {
          type: 'string',
          description: 'The card as plain text: what search, history, the mobile app and the terminal show',
        },
      },
      required: ['spec', 'fallbackText'],
    },
  },
  async handler(args) {
    const spec = args.spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return err('spec must be an object: { root, elements }');
    }
    const fallbackText = typeof args.fallbackText === 'string' ? args.fallbackText.trim() : '';
    if (!fallbackText) return err('fallbackText is required: the card as plain text');
    const denial = chatSendDenial();
    if (denial) return err(denial);

    const r = routing();
    if (!r.platform_id || !r.channel_type) {
      return err('This session has no conversation to post a card in. Use send_message to reach a destination.');
    }
    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', spec, fallbackText }),
    });
    log(`send_card: ${id}, awaiting host ack`);

    const ack = await awaitDeliveryAck(id, SEND_CARD_ACK_TIMEOUT_MS);
    if (!ack) {
      return ok(
        `Card sent (id: ${id}), delivery unconfirmed: the host did not answer within ${SEND_CARD_ACK_TIMEOUT_MS / 1000}s.`,
      );
    }
    if (ack.status === 'delivered') return ok(`Card posted (id: ${id}).`);
    return err(`Card not posted (id: ${id}). ${ack.error ?? 'Unknown delivery error.'}`);
  },
};

registerTools([askUserQuestion, sendCard]);
