import { registerResource } from '../crud.js';
import type { Ask } from '../../modules/open-asks/asks.js';
import { claimAsk, getMarks, listAsks, resolveAsk } from '../../modules/open-asks/store.js';

type ListedAsk = Ask & { claimedBy: string | null; resolvedBy: string | null; resolution: string | null };

async function knownAsk(id: string): Promise<void> {
  if (!(await listAsks({ nowMs: Date.now() })).some((a) => a.id === id)) {
    throw new Error(`No open ask with id ${id}. Run \`ncl asks list\` for current ids.`);
  }
}

registerResource({
  name: 'ask',
  plural: 'asks',
  table: 'open_ask_marks',
  description:
    'Open asks: every place an agent is waiting on a person — an outcome whose "Needs you" line has had no human ' +
    'reply in its thread, an unanswered ask_question card, or a task that needs input. Openness is read from those ' +
    'sources each time; this table only records who picked an ask up, why one was settled elsewhere, and which owner ' +
    'alerts went out. An operator ask nobody claims within 2h alerts the owner; one still open at 24h is reminded once.',
  idColumn: 'ask_id',
  columns: [
    { name: 'ask_id', type: 'string', description: 'outcome:<message id>, question:<session>:<ms> or task:<task id>.' },
    { name: 'claimed_by', type: 'string', description: 'Who picked the ask up (an Anderton session name).' },
    { name: 'claimed_at', type: 'string', description: 'When it was claimed.' },
    { name: 'resolved_by', type: 'string', description: 'Who closed it outside its thread.' },
    { name: 'resolved_at', type: 'string', description: 'When it was closed outside its thread.' },
    { name: 'resolution', type: 'string', description: 'Why it is settled, e.g. where the call was made.' },
    { name: 'alerted_at', type: 'string', description: 'When the owner was alerted that nobody had claimed it.' },
    { name: 'reminded_at', type: 'string', description: 'When the owner was reminded it was still unanswered.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description: 'List open asks, oldest first. Resolved ones are hidden unless --all.',
      args: [
        { name: 'workgroup', type: 'string', description: 'Only asks from this workgroup id.' },
        { name: 'all', type: 'boolean', description: 'Include asks marked resolved outside their thread.' },
      ],
      handler: async (args): Promise<ListedAsk[]> => {
        const asks = await listAsks({ workgroupId: args.workgroup as string | undefined, nowMs: Date.now() });
        const marks = await getMarks(asks.map((a) => a.id));
        return asks
          .map((a) => {
            const m = marks.get(a.id);
            return {
              ...a,
              claimedBy: m?.claimed_by ?? null,
              resolvedBy: m?.resolved_by ?? null,
              resolution: m?.resolution ?? null,
            };
          })
          .filter((a) => args.all === true || a.resolvedBy === null);
      },
    },
    claim: {
      access: 'open',
      hostOnly: true,
      description: 'Record that you are handling an ask, so the owner is not alerted about it at 2h.',
      args: [
        { name: 'id', type: 'string', description: 'Ask id from `ncl asks list`.', required: true },
        { name: 'by', type: 'string', description: 'Who is handling it (your session name).', required: true },
      ],
      examples: ['ncl asks claim --id outcome:msg-123 --by workgroup-anderton'],
      handler: async (args) => {
        const id = args.id as string;
        await knownAsk(id);
        await claimAsk(id, args.by as string, new Date().toISOString());
        return { claimed: id };
      },
    },
    resolve: {
      access: 'open',
      hostOnly: true,
      description:
        'Close an ask that was settled outside its thread (e.g. the owner decided in a DM). A reply in the thread ' +
        'closes it on its own; use this only when no reply will come.',
      args: [
        { name: 'id', type: 'string', description: 'Ask id from `ncl asks list`.', required: true },
        { name: 'reason', type: 'string', description: 'Where and how it was settled.', required: true },
        { name: 'by', type: 'string', description: 'Who is closing it.', default: 'host-operator' },
      ],
      examples: ['ncl asks resolve --id outcome:msg-123 --reason "the owner sent it from a DM"'],
      handler: async (args) => {
        const id = args.id as string;
        await knownAsk(id);
        await resolveAsk(
          id,
          args.reason as string,
          (args.by as string | undefined) ?? 'host-operator',
          new Date().toISOString(),
        );
        return { resolved: id };
      },
    },
  },
});
