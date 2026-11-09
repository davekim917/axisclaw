import { PENDING_APPROVAL_STATUSES } from '../../types.js';
import { registerResource } from '../crud.js';
import { chooseFromHost } from '../../modules/approvals/host-choose.js';
import { resolveApprovalFromHost } from '../../modules/approvals/response-handler.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by requestApproval() (self-mod install_packages/add_mcp_server) and OneCLI credential approval flow. Rows are deleted after the admin approves/rejects or the request expires.',
  idColumn: 'approval_id',
  columns: [
    {
      name: 'approval_id',
      type: 'string',
      description: 'Unique approval identifier (also used as the card questionId).',
    },
    {
      name: 'session_id',
      type: 'string',
      description: 'Session that requested the approval. Null for OneCLI credential approvals.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original request identifier (OneCLI request UUID or same as approval_id).',
    },
    {
      name: 'action',
      type: 'string',
      description:
        'Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, onecli_credential).',
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
    { name: 'channel_type', type: 'string', description: 'Channel the approval card was delivered on.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID the card was delivered to.' },
    {
      name: 'platform_message_id',
      type: 'string',
      description: 'Platform message ID of the delivered card (for editing on expiry).',
    },
    { name: 'expires_at', type: 'string', description: 'When this approval expires (OneCLI gateway TTL).' },
    {
      name: 'status',
      type: 'string',
      description:
        'Current status. awaiting_reason means the admin chose "Reject with reason…" and the reply is still pending.',
      enum: [...PENDING_APPROVAL_STATUSES],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    approve: {
      access: 'open',
      description:
        'Resolve a pending approval as APPROVED from the host terminal — same effect as clicking Approve on the card. ' +
        'Use --id <approval-id>. Host operator only; the DM card (wherever it landed) becomes a no-op after this. ' +
        'OneCLI credential approvals cannot be resolved here.',
      handler: async (args, ctx) => {
        if (ctx.caller === 'agent') throw new Error('Agents cannot resolve approvals.');
        const id = args.id as string;
        if (!id) throw new Error('--id <approval-id> is required');
        const result = await resolveApprovalFromHost(id, 'approve', 'host-operator');
        if (!result.resolved) throw new Error(result.error ?? 'approval not resolved');
        if (result.declined) return { declined: id, reason: result.declined };
        return { approved: id };
      },
    },
    choose: {
      access: 'open',
      description:
        'Answer a choice card (a release, migration or approved-run card) as the owner, from the host — the same as the owner clicking that option on the card. ' +
        'Use --id <approval-id> --option <value>; --option must be one of the card’s own option values. ' +
        'Recorded under the owner’s own id for that card, marked "(from the host)" on the card and in the receipt. ' +
        'It never answers as anyone else: a card whose approvers do not include the owner is refused. ' +
        "Host only. The host's Claude Code ask rule on this command is what makes each use the owner's own yes. " +
        'Every use also notifies the owner, naming the processes that ran it. ' +
        'OneCLI credential approvals are out of scope.',
      hostOnly: true,
      args: [
        { name: 'id', type: 'string', required: true, description: 'The choice card’s approval id (appr-…).' },
        { name: 'option', type: 'string', required: true, description: 'One of the card’s option values, e.g. ship.' },
      ],
      examples: ['ncl approvals choose --id appr-123 --option ship'],
      handler: async (args, ctx) => {
        if (ctx.caller === 'agent') throw new Error('Agents cannot resolve approvals.');
        const id = args.id as string;
        const option = args.option as string;
        const result = await chooseFromHost(id, option, ctx.caller === 'host' ? ctx.origin : undefined);
        if (!result.resolved) throw new Error(result.error);
        if (result.uncounted) {
          return { answered: id, option, by: result.userId, counted: false, reason: 'out-of-date release card' };
        }
        return { answered: id, option, label: result.label, by: result.userId };
      },
    },
    reject: {
      access: 'open',
      description:
        'Resolve a pending approval as REJECTED from the host terminal — same effect as clicking Reject on the card. ' +
        'Use --id <approval-id>. Host operator only.',
      handler: async (args, ctx) => {
        if (ctx.caller === 'agent') throw new Error('Agents cannot resolve approvals.');
        const id = args.id as string;
        if (!id) throw new Error('--id <approval-id> is required');
        const result = await resolveApprovalFromHost(id, 'reject', 'host-operator');
        if (!result.resolved) throw new Error(result.error ?? 'approval not resolved');
        return { rejected: id };
      },
    },
  },
});
