import { threadPermalink } from '../../dashboard/api/observatory.js';
import { openThreadFor, startThreadTask, wiredChannelIdNamed } from '../../open-thread.js';
import { MAX_THREAD_NAME_CHARS } from '../../channels/adapter.js';
import { renameSessionThread } from '../../thread-title.js';
import { registerResource } from '../crud.js';

/** Discord's message limit; the brief is posted as the thread's first message. */
const MAX_BRIEF = 2000;

const OPEN_THREAD_HINT = {
  agent_not_wired_to_channel:
    'the agent is not wired to that room; `ncl wirings list --agent-group-id <id>` shows where it is',
  channel_cannot_open_threads: "that room's channel adapter cannot open threads",
  thread_create_failed: 'the platform refused the post; see the host log',
} as const;

registerResource({
  name: 'thread',
  plural: 'threads',
  table: 'sessions',
  description: 'Threads in the rooms agents are wired to.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    open: {
      access: 'open',
      hostOnly: true,
      description:
        'Start new work in a room: post a parent message saying who opened it, open a thread under it with the brief ' +
        'as its first message, and wake the agent on the brief in that thread. The agent replies there like any ' +
        'thread it was asked in.',
      args: [
        { name: 'group', type: 'string', description: 'Agent group that will work the thread.', required: true },
        { name: 'channel', type: 'string', description: 'Room the agent is wired to, e.g. #eng.', required: true },
        {
          name: 'title',
          type: 'string',
          description: 'Short subject; names the parent post and the thread.',
          required: true,
        },
        {
          name: 'brief',
          type: 'string',
          description: `The task, posted verbatim and given to the agent (${MAX_BRIEF} characters at most).`,
          required: true,
        },
        { name: 'by', type: 'string', description: 'Who is opening it, shown on the parent post.', required: true },
      ],
      examples: [
        'ncl threads open --group ag-123 --channel "#eng" --title "Nightly export check" --brief "…" --by "Anderton for Avery"',
      ],
      handler: async (args) => {
        const group = args.group as string;
        const title = (args.title as string).trim();
        const brief = (args.brief as string).trim();
        const by = (args.by as string).trim();
        if (!title || !brief || !by) throw new Error('--title, --brief and --by must not be empty.');
        if (brief.length > MAX_BRIEF)
          throw new Error(`--brief is ${brief.length} characters; the limit is ${MAX_BRIEF}.`);

        const channel = args.channel as string;
        const channelId = await wiredChannelIdNamed(group, channel);
        const opened = channelId
          ? await openThreadFor(group, channelId, `${title} — opened by ${by}`, title, brief)
          : ({ error: 'agent_not_wired_to_channel', channel } as const);
        if ('error' in opened) {
          throw new Error(`Could not open a thread in ${opened.channel}: ${OPEN_THREAD_HINT[opened.error]}.`);
        }
        const threadUrl = await threadPermalink(opened.threadId).catch(() => null);
        const task = await startThreadTask({
          agentGroupId: group,
          messagingGroupId: opened.messagingGroupId,
          threadId: opened.threadId,
          name: `thread ${title}`,
          prompt:
            `${by} opened this thread for you.\n\nThe brief, verbatim:\n"""\n${brief}\n"""\n\n` +
            'Work it in THIS thread. If you cannot, say so here and name what blocks you.',
        });
        if (!task.ok) {
          throw new Error(
            `Opened ${threadUrl ?? opened.threadId}, but the agent was not woken (${JSON.stringify(task.error)}). ` +
              'Reply in the thread to start it.',
          );
        }
        return { threadId: opened.threadId, threadUrl, seriesId: task.seriesId };
      },
      formatHuman: (data) => {
        const { threadId, threadUrl } = data as { threadId: string; threadUrl: string | null };
        return `Opened ${threadUrl ?? threadId}; the agent is working the brief there.`;
      },
    },
    rename: {
      access: 'open',
      groupScopeVerb: true,
      description:
        'Run this when someone asks to rename this thread, typed or on a call. It names the thread you are in and takes ' +
        'no thread argument. The name stays: the automatic titles leave it alone from then on. Where threads have names ' +
        'it renames the real thread; elsewhere it changes the title in the app list only, and says so. If the platform ' +
        'refuses, the thread keeps its name and the error says why, so tell the person.',
      args: [
        {
          name: 'title',
          type: 'string',
          description: `The new name (${MAX_THREAD_NAME_CHARS} characters at most).`,
          required: true,
        },
      ],
      examples: ['ncl threads rename --title "Nightly export review"'],
      handler: async (args, ctx) => {
        if (ctx.caller !== 'agent') throw new Error('Only an agent session can rename its thread.');
        if (args.id !== undefined) throw new Error('This renames the thread you are in; it takes no thread argument.');
        return renameSessionThread(ctx.sessionId, args.title as string);
      },
      formatHuman: (data) => {
        const { title, appOnly } = data as { title: string; appOnly: boolean };
        return appOnly
          ? `Set the title to "${title}" in the app list only. Threads here have no name of their own to change.`
          : `Renamed this thread to "${title}".`;
      },
    },
  },
});
