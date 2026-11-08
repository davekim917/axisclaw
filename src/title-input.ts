/** People set a conversation's topic, and the first real reply says what a linked or attached thing is about. */
import type { MessageTailRow } from './modules/mailbox/index.js';
import { relayedWords } from './modules/voice-call/prompts.js';
import { latestMessageText, parseUtcTimestampMs, threadSoFar } from './thread-context.js';

export const TITLE_SYSTEM_PROMPT = `Write a short (≤60 char) plain-text label for this conversation, for someone scanning a list to find it again. No quotes, no prefix, no markdown: just the label.

The label names the subject: what is being discussed, reviewed, read, worked out or decided. The first message and first reply set it; a later message changes it only if the conversation has moved on from it. When the conversation is about something linked, attached or read, the label says what that thing is about, taken from what the agent read and said. It never says what kind of thing it is, where it came from or who wrote it. If the first message only points at something, take the subject from the reply.

Words for the conversation or its output, such as link, post, discussion, one-pager, handoff or follow-up, stay out unless that word is itself the subject.

Good labels: "EXAMPLE-71 rollout fix", "Slack auto-wire debug", "Snowflake credential audit", "Dropping feature branches for trunk-based releases".
Bad labels: "Conversation about X" (filler), "Here's a label: ..." (preamble), "**bold**" (markdown), "Article shared by a colleague" (the medium, not the subject), "Take over #12 and clear its comments" (an instruction, not a subject).`;

const OPENER_CHARS = 600;
const REPLY_CHARS = 600;
const LATEST_CHARS = 300;
const LINK_PREVIEW_CHARS = 300;
const LATEST_TURNS = 3;
/** Past the captions and sign-offs an agent posts around its work. */
const SUBSTANTIVE_REPLY_CHARS = 120;
/** A link or file under fewer words than this may lean on it for a subject; a longer message rarely does. */
const MAX_WORDS_WITHOUT_A_SUBJECT = 50;
const REPLY_WAIT_MS = 30 * 60_000;

const LINK = /https?:\/\/\S+/g;
const MENTION = /<?@[\w-]+>?/g;

export interface TitleTurn {
  key: string;
  atMs: number;
  role: 'human' | 'agent' | 'other';
  text: string;
  /** The thread before this message, when it was an agent's first wake on a thread already under way. */
  earlier: string | null;
  linkPreview: string;
  /** Its subject may live in a link or file only an agent can read. */
  pointsElsewhere: boolean;
}

interface MessageContent {
  id?: unknown;
  platformMsgId?: unknown;
  text?: unknown;
  prompt?: unknown;
  author?: { isBot?: unknown };
  attachments?: unknown;
  links?: Array<{ description?: unknown }>;
}

function parsed(row: MessageTailRow): MessageContent {
  try {
    return JSON.parse(row.content) as MessageContent;
  } catch {
    return { text: row.content };
  }
}

/** A link's description says what it is about before any agent has read it. Its title tends to name the source. */
function previewOf(links: MessageContent['links']): string {
  if (!Array.isArray(links)) return '';
  const described = links.filter((link) => typeof link?.description === 'string' && link.description.trim());
  return described.map((link) => String(link.description).trim()).join(' ');
}

const ownWords = (message: string): number =>
  message.replace(LINK, ' ').replace(MENTION, ' ').split(/\s+/).filter(Boolean).length;

export function inboundTurn(row: MessageTailRow): TitleTurn | null {
  if (row.kind === 'system') return null;
  const content = parsed(row);
  const raw = String(content.text ?? content.prompt ?? '').trim();
  const relayed = relayedWords(raw);
  const message = (relayed ?? latestMessageText(raw)).trim();
  const attached = Array.isArray(content.attachments) && content.attachments.length > 0;
  if (!message && !attached) return null;
  const earlier = threadSoFar(raw);
  const linkPreview = previewOf(content.links);
  const leansOnLink = attached || message.search(LINK) !== -1;
  const role =
    relayed !== null || (row.kind === 'chat-sdk' && content.author?.isBot === false)
      ? 'human'
      : content.author?.isBot === true
        ? 'agent'
        : 'other';
  return {
    key: String(content.platformMsgId ?? content.id ?? message),
    atMs: parseUtcTimestampMs(row.timestamp) ?? 0,
    role,
    text: message,
    earlier,
    linkPreview,
    pointsElsewhere: leansOnLink && !earlier && ownWords(message) <= MAX_WORDS_WITHOUT_A_SUBJECT,
  };
}

export function outboundTurn(row: MessageTailRow): TitleTurn | null {
  if (row.kind !== 'chat') return null;
  const text = String(parsed(row).text ?? '').trim();
  if (!text) return null;
  return {
    key: text,
    atMs: parseUtcTimestampMs(row.timestamp) ?? 0,
    role: 'agent',
    text,
    earlier: null,
    linkPreview: '',
    pointsElsewhere: false,
  };
}

const clip = (text: string, chars: number): string => text.replace(/\s+/g, ' ').trim().slice(0, chars);

function inOrder(turns: TitleTurn[]): TitleTurn[] {
  const distinct = new Map<string, TitleTurn>();
  for (const turn of [...turns].sort((a, b) => a.atMs - b.atMs)) {
    if (!distinct.has(turn.key)) distinct.set(turn.key, turn);
  }
  return [...distinct.values()];
}

export interface TitleInput {
  text: string;
  awaitingReply: boolean;
}

export function titleInput(allTurns: TitleTurn[], nowMs: number): TitleInput {
  const turns = inOrder(allTurns);
  const people = turns.filter((turn) => turn.role === 'human');
  const opener = people[0] ?? turns[0];
  if (!opener) return { text: '', awaitingReply: false };

  const replies = turns.filter((turn) => turn.role === 'agent' && turn !== opener && turn.atMs >= opener.atMs);
  const substantive = replies.find((turn) => turn.text.length >= SUBSTANTIVE_REPLY_CHARS);
  const reply = substantive ?? [...replies].sort((a, b) => b.text.length - a.text.length)[0];
  const later = (people.length > 0 ? people : turns.filter((turn) => turn.role === 'other'))
    .filter((turn) => turn !== opener)
    .slice(-LATEST_TURNS);

  const openingWords = [opener.earlier, opener.text].filter(Boolean).join(' ');
  const lines = [`First message: ${openingWords ? clip(openingWords, OPENER_CHARS) : 'a file, with no words'}`];
  if (opener.linkPreview) lines.push(`Linked page says: ${clip(opener.linkPreview, LINK_PREVIEW_CHARS)}`);
  if (reply) lines.push(`First reply: ${clip(reply.text, REPLY_CHARS)}`);
  for (const turn of later) lines.push(`Later message: ${clip(turn.text, LATEST_CHARS)}`);

  return {
    text: lines.join('\n'),
    awaitingReply: opener.pointsElsewhere && !substantive && nowMs - opener.atMs < REPLY_WAIT_MS,
  };
}

/**
 * A paraphrase of a label that already fits would drift a name people search by, and spend a rename on nothing. Asked
 * to repeat a label the model rewords it anyway, so keeping one takes a single word it cannot restyle.
 */
const KEEP_LABEL = 'KEEP';

export function titlePrompt(currentLabel: string | null, input: string): string {
  if (!currentLabel) return input;
  return `Current label: ${currentLabel}
First check the label. Replace it only if it describes the conversation instead of naming a subject: what kind of message, file or link started it, who spoke, or how the work was handed around. "Link from a colleague", "Meeting follow-up", "Greeting between agents", "Accepted task #12" and "Handoff to another thread" are labels to replace. A label that names a subject stays, even if it also mentions a person or a file.
To keep it, your whole reply is the single word ${KEEP_LABEL}, even if you could word it better, narrow it or add detail, and even if the conversation has moved on. To replace it, your whole reply is the new label, with no explanation.

${input}`;
}

/** Five letters is a stem: "results" and "result", "interpreting" and "interpretation" count as one word. */
const labelWords = (title: string): Set<string> =>
  new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map((word) => word.slice(0, 5)),
  );

/** Share of the shorter label's words the longer one repeats. Above it, a new label is the old one restyled. */
const SAME_LABEL_OVERLAP = 0.65;

function restyles(currentLabel: string, answer: string): boolean {
  const current = labelWords(currentLabel);
  const next = labelWords(answer);
  const shared = [...current].filter((word) => next.has(word)).length;
  return shared / Math.max(1, Math.min(current.size, next.size)) >= SAME_LABEL_OVERLAP;
}

/** One word is the model's verdict on the label, whichever word it picks, and never a better label. */
const isVerdict = (answer: string): boolean => answer.split(/\s+/).length < 2;

export function keepUnlessChanged(currentLabel: string | null, answer: string): string {
  if (!currentLabel) return answer;
  return isVerdict(answer) || restyles(currentLabel, answer) ? currentLabel : answer;
}
