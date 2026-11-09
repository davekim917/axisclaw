import { log } from '../../log.js';
import type { ContextUse, LiveCall, LiveEvent } from './live.js';
import {
  checkInText,
  greeting,
  groupCallEndedText,
  groupGreeting,
  groupVoiceInstructions,
  voiceCallEndedText,
  voiceInstructions,
  truncateMiddle,
  voiceRequestText,
  headcountChangeText,
  onCallText,
  progressText,
  voiceMirror,
} from './prompts.js';
import { startupContext, type FeedEvent, type SessionFeed } from './session-feed.js';

const OUTPUT_LIMIT_BYTES = 4000;
const SPOKEN_TRANSCRIPT_LIMIT = 8 * 1024;
/** A running request is spoken about at most this often, counted from its start or its last spoken reply. */
export const CHECK_IN_INTERVAL_MS = 120_000;

export interface CallParty {
  agentName: string;
  callerName: string;
  /** The chat app the call came from, as people call it. */
  platform: string;
  /** Several people on one call: requests pass `admit`, and the room's chatter is never written anywhere. */
  group?: boolean;
}

/** A group-call request the host accepted, already worded for the agent and for the thread. */
export interface AdmittedRequest {
  text: string;
  sender: string;
  mirror: string;
}

export interface CallPorts {
  openLive(input: { offer: string; instructions: string; onEvent: (event: LiveEvent) => void }): Promise<LiveCall>;
  feed(onEvent: (event: FeedEvent) => void): SessionFeed;
  /**
   * Writes a message into the call's session as the caller. The id is known before the write lands, so a reply racing
   * the write still finds its request; `wake` false leaves the message as context for the next turn.
   */
  inject(text: string, wake: boolean, sender?: string): { id: string; written: Promise<void> };
  /** Group calls only: the request in a delegated turn, or why it is not one. */
  admit?(delegationId: string, turn: string, arrivedAtMs: number): Promise<AdmittedRequest | 'empty' | 'duplicate'>;
  mirror(text: string): void;
  status(text: string): void;
  /** A piece of live transcript for the page's captions; `done` closes that side's line. */
  caption(role: 'caller' | 'voice', text: string, done: boolean): void;
  /** The greeting went to the voice. */
  greeted?(): void;
  ended(text: string): void;
}

class SpokenTranscript {
  private entries: Array<{ role: 'caller' | 'voice'; text: string }> = [];
  private open = { caller: false, voice: false };

  add(event: LiveEvent): void {
    if (event.type === 'transcript') {
      const last = this.entries[this.entries.length - 1];
      if (this.open[event.role] && last?.role === event.role) last.text += event.text;
      else this.entries.push({ role: event.role, text: event.text });
      this.open[event.role] = true;
    } else if (event.type === 'turn-done') {
      this.open[event.role] = false;
    } else return;
    let size = this.entries.reduce((sum, e) => sum + Buffer.byteLength(e.text) + 8, 0);
    while (size > SPOKEN_TRANSCRIPT_LIMIT && this.entries.length > 1)
      size -= Buffer.byteLength(this.entries.shift()!.text) + 8;
  }

  get callerSpoke(): boolean {
    return this.entries.some((e) => e.role === 'caller' && e.text.trim());
  }

  take(): string {
    const text = this.entries
      .filter((e) => e.text.trim())
      .map((e) => `${e.role === 'caller' ? 'Caller' : 'Voice'}: ${e.text.trim()}`)
      .join('\n');
    this.entries = [];
    this.open = { caller: false, voice: false };
    return text;
  }
}

export class VoiceCallBridge {
  private live: LiveCall | null = null;
  private feed: SessionFeed | null = null;
  private spoken = new SpokenTranscript();
  private groupRelays: Promise<void> = Promise.resolve();
  /** The session message each request became, to the delegation it answers. */
  private requests = new Map<string, string>();
  private active: string | null = null;
  /**
   * Requests answered by a reply in the current turn, and requests whose turn has ended. Only replies retire a request:
   * they arrive in delivery's order with the turn end, while progress is polled on its own clock and can run ahead.
   */
  private inTurn = new Set<string>();
  private done = new Set<string>();
  /** When each running request was last spoken about. */
  private lastSpoken = new Map<string, number>();
  private beforeLive: Array<[string, ContextUse, string | undefined]> = [];
  private sentAny = false;
  private connected = false;
  private greeted = false;
  private closed = false;
  private onCall: string[] | null = null;

  constructor(
    private readonly party: CallParty,
    private readonly ports: CallPorts,
  ) {}

  async start(offer: string): Promise<string> {
    if (this.closed) throw new Error('The call ended before it connected.');
    this.feed = this.ports.feed((event) => this.onFeed(event));
    const context = startupContext(this.feed.recent, this.party.agentName, this.party.platform);
    const instructions =
      (this.party.group
        ? groupVoiceInstructions(this.party.agentName, this.party.platform)
        : voiceInstructions(this.party.agentName, this.party.callerName, this.party.platform)) +
      (context ? `\n\n${context}` : '');
    try {
      this.live = await this.ports.openLive({ offer, instructions, onEvent: (event) => this.onLive(event) });
    } catch (err) {
      this.feed.close();
      this.closed = true;
      throw err;
    }
    if (this.closed) {
      this.live.close();
      throw new Error('The call ended while it was connecting.');
    }
    for (const [text, use, delegationId] of this.beforeLive.splice(0)) this.context(text, use, delegationId);
    if (!this.party.group)
      this.ports.mirror(`📞 ${this.party.callerName} started a voice call with ${this.party.agentName}.`);
    return this.live.answer;
  }

  audioConnected(): void {
    this.connected = true;
    this.greet();
  }

  peopleOnCall(names: string[]): void {
    if (!this.party.group || names.length === 0) return;
    const sorted = [...names].sort();
    const before = this.onCall;
    if (before && before.length === sorted.length && before.every((name, i) => name === sorted[i])) return;
    this.onCall = sorted;
    this.context(onCallText(sorted), 'know');
    const change = before && this.greeted ? headcountChangeText(before, sorted) : null;
    if (change) this.context(change, 'say');
  }

  private greet(): void {
    if (this.greeted || !this.connected || !this.live) return;
    this.greeted = true;
    this.context(
      this.party.group ? groupGreeting(this.party.agentName, this.onCall ?? []) : greeting(this.party.agentName),
      'say',
    );
    this.ports.greeted?.();
  }

  private context(text: string, use: ContextUse, delegationId?: string): void {
    if (this.closed) return;
    if (this.live) this.live.context(truncateMiddle(text, OUTPUT_LIMIT_BYTES), use, delegationId);
    else this.beforeLive.push([text, use, delegationId]);
  }

  private checkIn(delegation: string, note: string): boolean {
    const now = Date.now();
    const since = this.lastSpoken.get(delegation);
    if (since === undefined || now - since < CHECK_IN_INTERVAL_MS) return false;
    this.lastSpoken.set(delegation, now);
    this.context(checkInText(note), 'check-in', delegation);
    return true;
  }

  private onLive(event: LiveEvent): void {
    if (this.closed) return;
    if (event.type === 'started') {
      this.greet();
      return;
    }
    if (event.type === 'closed') {
      this.end({ dropped: false, reason: 'The voice service ended the call.' });
      return;
    }
    if (event.type === 'delegation') {
      this.delegate(event.id, event.text);
      return;
    }
    if (event.type === 'transcript') this.ports.caption(event.role, event.text, false);
    else this.ports.caption(event.role, '', true);
    this.spoken.add(event);
  }

  private delegate(id: string, request: string): void {
    this.lastSpoken.set(id, Date.now());
    if (this.ports.admit) {
      const arrivedAtMs = Date.now();
      this.groupRelays = this.groupRelays
        .then(() => this.delegateInGroup(id, request, arrivedAtMs))
        .catch((err: unknown) => log.warn('Voice call: a group request could not be relayed', { err }));
      return;
    }
    const transcript = this.spoken.take();
    if (!request.trim() && !transcript) return;
    const text = voiceRequestText({ callerName: this.party.callerName, request, transcript, first: !this.sentAny });
    this.sentAny = true;
    this.ports.status(`${this.party.agentName} is working…`);
    const injected = this.ports.inject(text, true);
    this.requests.set(injected.id, id);
    injected.written.then(
      () => {
        if (request.trim()) this.ports.mirror(voiceMirror(this.party.callerName, request.trim()));
      },
      (err: unknown) => {
        log.warn('Voice call: request may not have reached the session', { err });
        this.context(
          `That request may not have reached ${this.party.agentName}. Ask the caller to check the thread before asking again.`,
          'say',
          id,
        );
      },
    );
  }

  private async delegateInGroup(id: string, turn: string, arrivedAtMs: number): Promise<void> {
    this.spoken.take();
    let admitted: AdmittedRequest | 'empty' | 'duplicate';
    try {
      admitted = await this.ports.admit!(id, turn, arrivedAtMs);
    } catch (err) {
      log.warn('Voice call: could not read a group request', { err });
      if (!this.closed)
        this.context(`That request did not reach ${this.party.agentName}. Ask them to say it again.`, 'say', id);
      return;
    }
    if (this.closed) return;
    if (admitted === 'empty') {
      this.context('Nothing was said, so nothing was sent. Stay silent.', 'know');
      return;
    }
    if (admitted === 'duplicate') {
      this.context(`${this.party.agentName} already has this request. Stay silent.`, 'know');
      return;
    }
    this.sentAny = true;
    this.ports.status(`${this.party.agentName} is working…`);
    const injected = this.ports.inject(admitted.text, true, admitted.sender);
    this.requests.set(injected.id, id);
    await injected.written.then(
      () => this.ports.mirror(admitted.mirror),
      (err: unknown) => {
        log.warn('Voice call: request may not have reached the session', { err });
        this.context(
          `That request may not have reached ${this.party.agentName}. Ask them to check the thread before asking again.`,
          'say',
          id,
        );
      },
    );
  }

  /** The request a message names: its delegation, `'finished'` once its turn has ended, or null for any other message. */
  private requestNamed(inReplyTo: string | null): string | 'finished' | null {
    const id = inReplyTo ? this.requests.get(inReplyTo) : undefined;
    if (!id) return null;
    return this.done.has(id) ? 'finished' : id;
  }

  private onFeed(event: FeedEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'inbound':
        this.context(`In the thread, ${event.sender}: ${event.text}`, 'say');
        return;
      case 'progress': {
        const named = this.requestNamed(event.inReplyTo);
        if (named === 'finished') return;
        const delegation = named ?? this.active;
        if (delegation && !this.checkIn(delegation, event.text)) this.context(progressText(event.text), 'know');
        return;
      }
      case 'reply': {
        const named = this.requestNamed(event.inReplyTo);
        if (named && named !== 'finished') this.active = named;
        const delegation = named === 'finished' ? null : (named ?? this.active);
        if (delegation) {
          this.inTurn.add(delegation);
          this.lastSpoken.set(delegation, Date.now());
          this.context(event.text, 'say', delegation);
        } else this.context(`${this.party.agentName} posted in the thread: ${event.text}`, 'say');
        return;
      }
      case 'turn-end':
        for (const id of this.inTurn) {
          this.done.add(id);
          this.lastSpoken.delete(id);
        }
        this.inTurn.clear();
        this.active = null;
        this.ports.status('Live');
        return;
    }
  }

  end({ dropped, reason }: { dropped: boolean; reason: string }): void {
    if (this.closed) return;
    this.closed = true;
    this.live?.close();
    this.feed?.close();
    const leftover = !this.party.group && this.spoken.callerSpoke ? this.spoken.take() : '';
    if (leftover || this.sentAny) {
      const text = this.party.group
        ? groupCallEndedText()
        : voiceCallEndedText(this.party.callerName, leftover, dropped);
      this.ports
        .inject(text, Boolean(leftover))
        .written.catch((err: unknown) =>
          log.warn('Voice call: the end of the call did not reach the session', { err }),
        );
    }
    if (!this.party.group)
      this.ports.mirror(`📞 Voice call with ${this.party.agentName} ${dropped ? 'dropped' : 'ended'}.`);
    this.ports.ended(reason);
  }
}
