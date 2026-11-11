/**
 * The host side of "a person's message may carry `-m`/`-e`/`-f` flags", shared by every path that writes such a
 * message into a session: parse with the session's provider vocabulary, post the ⚙️ confirmation (or the error notice)
 * to the given address, and fold the structured intent into the row's content so the container never re-parses text.
 */
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import { formatFlagConfirmation, parseMessageFlags, type FlagIntent } from './flag-parser.js';
import { withExistingNanoclawOutbound } from './modules/mailbox/index.js';
import type { Session } from './types.js';

export interface FlagNoticeAddress {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

export interface AppliedMessageFlags {
  flagIntent?: FlagIntent;
  /** `null` when the text carried no flags and must be written as it came. */
  cleanedText: string | null;
  /** The posted ⚙️ ack's settings line, so the runner can say "queued" in the same words. */
  flagAck?: string;
}

export interface ParsedMessageFlags {
  flags: AppliedMessageFlags;
  /** The ⚙️ confirmation and/or error lines to post; empty when there is nothing to say. */
  notice: string;
}

/** Parses with the session's provider vocabulary; posts nothing. */
export async function parseSessionMessageFlags(
  session: Session,
  /** `agent_groups.agent_provider`: covers a group created mid-run, which has no container_configs row until restart. */
  agentGroupProvider: string | null | undefined,
  rawText: string,
): Promise<ParsedMessageFlags> {
  // Reads the container_configs projection (spawn reads container.json, so the two can disagree).
  const provider = resolveProviderName(
    session.agent_provider,
    (await getContainerConfig(session.agent_group_id))?.provider ?? agentGroupProvider,
  );
  const parsed = parseMessageFlags(rawText, provider);
  if (!parsed.intent && parsed.errors.length === 0 && parsed.warnings.length === 0) {
    return { flags: { cleanedText: null }, notice: '' };
  }
  const notice = formatFlagConfirmation(parsed.intent ?? {}, parsed.warnings, parsed.errors);
  const settingsLine = notice.split('\n')[0];
  const flagAck = notice && parsed.intent && settingsLine.startsWith('⚙️') ? settingsLine : undefined;
  return {
    flags: {
      ...(parsed.intent ? { flagIntent: parsed.intent } : {}),
      cleanedText: parsed.cleanedText,
      ...(flagAck ? { flagAck } : {}),
    },
    notice,
  };
}

export async function postFlagNotice(
  session: Session,
  notice: string,
  address: FlagNoticeAddress,
  /** A caller that may retry the same message passes a stable id; the outbound insert ignores a repeat. */
  noticeId?: string,
): Promise<void> {
  if (!notice) return;
  // Outbound-keyed and existing-only: never provision a mailbox for a notice.
  await withExistingNanoclawOutbound(session.agent_group_id, session.id, (outbound) =>
    outbound.writeOutboundDirect({
      id: noticeId ?? `flag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: address.platformId,
      channelType: address.channelType,
      threadId: address.threadId,
      content: JSON.stringify({ text: notice }),
    }),
  );
}

/** Parse, then post the notice before the caller writes the row. */
export async function applyMessageFlags(opts: {
  session: Session;
  agentGroupProvider: string | null | undefined;
  rawText: string;
  noticeAddress: FlagNoticeAddress;
}): Promise<AppliedMessageFlags> {
  const { flags, notice } = await parseSessionMessageFlags(opts.session, opts.agentGroupProvider, opts.rawText);
  await postFlagNotice(opts.session, notice, opts.noticeAddress);
  return flags;
}

/** Folds an `applyMessageFlags` result into a row's JSON content; unchanged when the text carried no flags. */
export function withMessageFlags(content: string, flags: AppliedMessageFlags): string {
  if (!flags.flagIntent && flags.cleanedText === null) return content;
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (flags.cleanedText !== null) parsed.text = flags.cleanedText;
  if (flags.flagIntent) parsed.flagIntent = flags.flagIntent;
  if (flags.flagAck) parsed.flagAck = flags.flagAck;
  return JSON.stringify(parsed);
}
