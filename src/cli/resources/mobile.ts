// `pair` needs no approval, like `ncl voice call`: the link speaks only as the person it is sent to and goes only to
// their DM. Who that person is comes from the thread, so no verb takes a user from the agent.
import { TIMEZONE } from '../../config.js';
import { deleteDevice, listDevices, type MobileDevice } from '../../modules/mobile/devices.js';
import { askerIds, pairFromThread } from '../../modules/mobile/pairing.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'mobile',
  plural: 'mobile',
  table: 'mobile_devices',
  description: 'Pair the Anderton phone app to the person you are talking to, and manage their paired devices.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    pair: {
      access: 'open',
      description:
        "Run this when the person asks to install, set up or sign in to the Anderton app on their phone. The host sends a one-time link to their DM (never post or ask for it here); it expires 10 minutes after it is sent. One pairing covers all of a person's agents in that Slack workspace or on Discord.",
      args: [],
      examples: ['ncl mobile pair'],
      handler: async (_args, ctx) => {
        if (ctx.caller !== 'agent') throw new Error('Only an agent session can pair the app.');
        return pairFromThread({ sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId });
      },
      formatHuman: (data) => {
        const { sentTo, expiresAt } = data as { sentTo: string; expiresAt: string };
        return `Pairing link sent to ${sentTo}'s DM; it expires at ${formatLocalTime(expiresAt, TIMEZONE)}. Tell them to open it on their phone.`;
      },
    },
    devices: {
      access: 'open',
      description:
        "List paired devices: from an agent, those of the person you are talking to; from the host, everyone's.",
      args: [],
      examples: ['ncl mobile devices'],
      handler: async (_args, ctx) =>
        listDevices(
          ctx.caller === 'agent'
            ? await askerIds({ sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId })
            : undefined,
        ),
      formatHuman: (data) => {
        const devices = data as MobileDevice[];
        if (devices.length === 0) return 'No paired devices.';
        return devices
          .map(
            (d) =>
              `${d.id}  ${d.label ?? '(unnamed)'}  ${d.user_id}  paired ${formatLocalTime(d.created_at, TIMEZONE)}`,
          )
          .join('\n');
      },
    },
    revoke: {
      access: 'open',
      description:
        'Revoke one paired device so its key stops working: from an agent, only a device of the person you are talking to.',
      args: [{ name: 'id', type: 'string', required: true, description: 'The device id, from ncl mobile devices.' }],
      examples: ['ncl mobile revoke --id <device>'],
      handler: async (args, ctx) => {
        const owners =
          ctx.caller === 'agent'
            ? await askerIds({ sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId })
            : undefined;
        if (!(await deleteDevice(args.id as string, owners))) throw new Error(`No such device: ${String(args.id)}`);
        return { revoked: args.id };
      },
    },
  },
});
