// `takeover` needs no approval: the owner opening the link is the consent, and it goes nowhere but their DM.
import { finishBrowserTakeover, startBrowserTakeover } from '../../modules/browser-takeover/service.js';
import { formatLocalTime } from '../../timezone.js';
import { TIMEZONE } from '../../config.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

function agentSession(ctx: CallerContext): { sessionId: string; agentGroupId: string } {
  if (ctx.caller !== 'agent') throw new Error('Only an agent session can hand a sign-in to an owner.');
  return { sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId };
}

registerResource({
  name: 'browser',
  plural: 'browser',
  table: 'sessions',
  description: 'Have an owner sign in to a site for you, so you get the signed-in session and never the password.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    takeover: {
      access: 'open',
      description:
        'Ask an owner to sign in to a site for you. Opens --url in a separate browser you cannot see and DMs an owner or global admin a one-time link (30 minutes) to it, where they sign in themselves (SSO, MFA). Returns at once; they reply in this conversation when done, and then you run `ncl browser finish`.\n\n' +
        'A new takeover from this session replaces any open one.',
      args: [
        { name: 'url', type: 'string', description: 'The sign-in page to open for them.', required: true },
        {
          name: 'site',
          type: 'string',
          description: 'Short name the saved login is filed under, e.g. "amplitude".',
          required: true,
        },
        { name: 'reason', type: 'string', description: 'Anything they should know, e.g. "use the company SSO tile".' },
      ],
      examples: ['ncl browser takeover --url https://app.example.com/login --site example'],
      handler: async (args, ctx) =>
        startBrowserTakeover({
          ...agentSession(ctx),
          url: String(args.url),
          site: String(args.site),
          reason: args.reason === undefined ? undefined : String(args.reason),
        }),
      formatHuman: (data) =>
        `Sign-in link sent to an owner's DM; it expires ${formatLocalTime((data as { expiresAt: string }).expiresAt, TIMEZONE)}. Wait for their reply here, then run \`ncl browser finish\`.`,
    },
    finish: {
      access: 'open',
      description:
        "After the owner says they signed in: save that browser's session to /workspace/browser-state/<site>.json (/workspace/browser-state-private/<site>.json when this agent's config widens that site) and close it. Then `agent-browser state load <the path it prints>`, and check you landed signed in.",
      args: [],
      examples: ['ncl browser finish'],
      handler: async (_args, ctx) => finishBrowserTakeover(agentSession(ctx).sessionId),
      formatHuman: (data) => {
        const { path, privateToAgent } = data as { path: string; privateToAgent?: true };
        return privateToAgent
          ? `Saved. Run: agent-browser state load ${path} — it is a live login that also holds an identity provider's sign-in, approved for this agent alone; never print, copy or commit it.`
          : `Saved. Run: agent-browser state load ${path} — it is a live login shared with your workgroup's agents; never print, copy or commit it.`;
      },
    },
  },
});
