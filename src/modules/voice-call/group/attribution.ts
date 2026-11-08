/** One piece of the voice service's live transcript, stamped on the bridge's audio clock when it arrived. */
export interface TranscriptPiece {
  /** Arrival on the bridge's audio clock, in seconds. */
  at: number;
  /** The piece's span on the service's own input timeline, which drifts from real time over a long call. */
  startMs: number;
  endMs: number;
  text: string;
}

/** Per-person loudness on the bridge's audio clock: frame index (20 ms) to dB×10 for each slot. */
export type ActivityFrames = Map<number, number[]>;

export const FRAME_SECONDS = 0.02;
const SPEECH_DB10 = -450;
/** How long after speech the service's transcript of it arrives, measured in the room spike. */
const TRANSCRIPT_LAG_SECONDS = 0.6;
const WINDOW_PAD_SECONDS = 0.3;
/** Below this share of the window the speaker heard is not the one who said the request. */
const MIN_COVERAGE = 0.3;
const MAX_REQUEST_SECONDS = 15;
const DUPLICATE_WINDOW_MS = 5_000;
const MAX_SHOWN_CHARS = 600;
/** What the thread shows for words said to the agent that never name it. */
export const UNNAMED_SHOWN = '(a follow-up on the call)';

const normalizeWord = (word: string) =>
  word
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

function editDistance(a: string, b: string): number {
  const from = Array.from(a);
  const to = Array.from(b);
  const row = Array.from({ length: to.length + 1 }, (_, j) => j);
  for (let i = 1; i <= from.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= to.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (from[i - 1] === to[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[to.length];
}

/** Whether a word is the agent's name as a speech model may have heard it: exact for short names, one edit off for longer. */
export function nameMatcher(agentName: string): (word: string) => boolean {
  const names = agentName.split(/\s+/).map(normalizeWord).filter(Boolean);
  return (word) => {
    const heard = normalizeWord(word);
    if (!heard) return false;
    return names.some((name) => (Array.from(name).length <= 4 ? heard === name : editDistance(heard, name) <= 1));
  };
}

const sentencesOf = (text: string) =>
  text
    .trim()
    .split(/(?<=[.?!])\s+|(?<=[。！？])/u)
    .filter((sentence) => sentence.trim());
/** Words as the name matcher sees them; scripts written without spaces still separate at their own punctuation. */
const wordsOf = (text: string) => text.split(/[\s、。，！？；：]+/u).filter((word) => normalizeWord(word));
const mentions = (text: string, isName: (word: string) => boolean) => wordsOf(text).some(isName);
/** Words compare equal across re-sends whatever punctuation trails them, but "10.5" never equals "105". */
const sameWord = (a: string, b: string) => {
  const trim = (word: string) =>
    word
      .normalize('NFC')
      .toLocaleLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return trim(a) === trim(b);
};

/** Display only: a sentence speaks to the agent when its name is set off by punctuation or ends it. */
function speaksTo(sentence: string, isName: (word: string) => boolean): boolean {
  const words = sentence.split(/\s+/).filter((word) => normalizeWord(word));
  return words.some((word, i) => isName(word) && (/[,;:?!.、，]$/u.test(word) || i === words.length - 1));
}

export interface HandedOver {
  turn: string;
  atMs: number;
}

export interface TurnRequest {
  /** Everything said since the turn last handed over, word for word: what the agent gets. */
  text: string;
  /** What people see in the thread and on their phones, from where the agent is first spoken to. */
  shown: string;
}

/**
 * What a delegation hands the agent. The voice service sends the whole turn so far, and again with more words in each
 * later delegation of the same turn, so the agent gets every word after the turn it already has, chatter included:
 * every rule that trimmed chatter also trimmed instructions. 'duplicate' when a re-send adds nothing within seconds of
 * the last; null when the turn is empty. Whether speech was meant for the agent is the voice's call, not this one's: the
 * voice hears the audio, while the text it hands over can spell the name another way ("Kye" for "Kai") or leave it out.
 */
export function requestFromTurn(
  turn: string,
  isName: (word: string) => boolean,
  previous: HandedOver | null = null,
  nowMs = Date.now(),
  solo = false,
): TurnRequest | 'duplicate' | null {
  if (turn.trim() === '') return null;
  const words = turn.trim().split(/\s+/);
  const before = previous ? previous.turn.trim().split(/\s+/) : [];
  let shared = 0;
  while (shared < Math.min(words.length, before.length) && sameWord(words[shared], before[shared])) shared += 1;
  const continues = previous !== null && shared === before.length;
  if (continues && shared === words.length && nowMs - previous.atMs <= DUPLICATE_WINDOW_MS) return 'duplicate';
  const text = (continues && shared < words.length ? words.slice(shared) : words).join(' ');
  const sentences = sentencesOf(text);
  let from = sentences.findIndex((sentence) => speaksTo(sentence, isName));
  if (from < 0) from = sentences.findIndex((sentence) => mentions(sentence, isName));
  const shown = solo ? text : from >= 0 ? sentences.slice(from).join(' ') : UNNAMED_SHOWN;
  return { text, shown: shown.length > MAX_SHOWN_CHARS ? `${shown.slice(0, MAX_SHOWN_CHARS)}…` : shown };
}

/**
 * Who said the request, as far as the room can tell: the one person whose microphone carried speech while the request
 * was spoken, placed by when its transcript arrived. Null when nobody, or more than one person, was speaking then.
 * A display label only: it never carries authority.
 */
export function speakerOf(input: {
  pieces: TranscriptPiece[];
  frames: ActivityFrames;
  slots: Record<string, number>;
  isName: (word: string) => boolean;
}): string | null {
  const { pieces, frames, slots, isName } = input;
  let first = pieces.length - 1;
  while (first >= 0 && !mentions(pieces[first].text, isName)) first -= 1;
  if (first < 0) return null;
  const request = pieces.slice(first);
  const spoken = Math.min(
    MAX_REQUEST_SECONDS,
    Math.max(0.5, (request[request.length - 1].endMs - request[0].startMs) / 1000),
  );
  const end = request[request.length - 1].at - TRANSCRIPT_LAG_SECONDS;
  const from = Math.floor((end - spoken - WINDOW_PAD_SECONDS) / FRAME_SECONDS);
  const to = Math.floor((end + WINDOW_PAD_SECONDS) / FRAME_SECONDS);
  const speaking = new Map<string, number>();
  let heard = 0;
  for (let frame = from; frame <= to; frame++) {
    const levels = frames.get(frame);
    if (!levels) continue;
    heard += 1;
    for (const [identity, slot] of Object.entries(slots)) {
      if ((levels[slot] ?? -1200) > SPEECH_DB10) speaking.set(identity, (speaking.get(identity) ?? 0) + 1);
    }
  }
  if (speaking.size !== 1 || heard === 0) return null;
  const [[identity, count]] = [...speaking];
  return count / heard >= MIN_COVERAGE ? identity : null;
}
