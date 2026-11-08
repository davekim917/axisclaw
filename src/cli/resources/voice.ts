// `call` needs no approval: a link always speaks as the person it is sent to and goes only to their DM. An invite
// lets the agent pick that person, but only among people on the call's channel who may already talk to it.
import { TIMEZONE } from '../../config.js';
import { startCall } from '../../modules/voice-call/group/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'voice',
  plural: 'voice',
  table: 'sessions',
  description: 'Let the person you are talking to call you by voice from their phone.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    call: {
      access: 'open',
      description:
        'Run this when the person asks to call you, start a call, talk by voice, hop on a call, or join the call. From a channel, the call is one anyone in the channel can join: when a call is already live in this conversation, this adds the person who asked; to bring in someone else, pass --invite with their user id or mention and they get their own link. One person on the call talks to you without saying your name; once several are on, people say your name to reach you. The host sends a one-time link to their DM (never post or ask for it here); it expires 5 minutes after it is sent. During a call, spoken requests arrive in this conversation as messages marked [Voice call] or [Group voice call], and your replies are read aloud, so open each reply with one to three plain spoken sentences. Everyone in the thread still sees your replies.',
      args: [
        // Not `group`: the group-scope CLI guard reads an arg by that name as an agent group id and refuses it.
        {
          name: 'group_call',
          type: 'boolean',
          description: 'Optional: a call from a channel is already one others can join.',
        },
        {
          name: 'invite',
          type: 'string',
          description:
            'Optional: while a call is live in this conversation, send someone else in the channel their own link to join it. Their user id or mention (e.g. <@U0ABC123>), not their name.',
        },
        {
          name: 'direct',
          type: 'boolean',
          description:
            'Optional, in a DM: a private call with just this person, even when a call they could join is live elsewhere. Without it, a person asking in a DM while such a call is live gets a link to that call.',
        },
      ],
      examples: ['ncl voice call', 'ncl voice call --invite <@U0ABC123>'],
      handler: async (args, ctx) => {
        if (ctx.caller !== 'agent') throw new Error('Only an agent session can start a voice call.');
        return startCall(
          { sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId },
          {
            group: args.group_call === true,
            ...(typeof args.invite === 'string' ? { invite: args.invite } : {}),
            ...(args.direct === true ? { direct: true } : {}),
          },
        );
      },
      formatHuman: (data) => {
        const { sentTo, expiresAt, group, joined } = data as {
          sentTo: string;
          expiresAt: string;
          group?: boolean;
          joined?: boolean;
        };
        const what = !group ? 'Call link' : joined ? 'Link to join the call' : 'Call started; link';
        return `${what} sent to ${sentTo}'s DM; it expires at ${formatLocalTime(expiresAt, TIMEZONE)}. Tell them to check their DM.${group && !joined ? ' Others in this channel join by asking you to add them.' : ''}`;
      },
    },
  },
});
