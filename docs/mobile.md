# Mobile app

Anderton is a native companion to the fleet. A person pairs their phone once, sees the threads they can use, and joins
a group call with an agent from the thread list instead of a DM link. Calls are the first feature, not the only one,
so nothing in the API is named for them except the call endpoint.

The app lives in `mobile/` at the repo root and uses the URL scheme `anderton`. The host half is `src/modules/mobile/`,
and it needs `PREVIEW_ORIGIN_SUFFIX`: the API is served on the preview listener at
the fixed name `https://app.<suffix>`, which cannot collide with a preview or call id because those are 32 hex
characters. `src/modules/preview/proxy.ts` checks this host before its id routing. The app learns the base URL from
the pairing link, never from a built-in value.

## Pairing

1. Someone asks the agent to set up the app. The agent runs `ncl mobile pair`.
2. The host picks the person from the session's latest human message, never from the agent, and refuses if there is
   none or if they cannot access this agent group.
3. It DMs them a one-time link, `https://app.<suffix>/pair#<code>`. The code never comes back to the agent, and thread
   history replays the link with its code removed.
4. The page turns the fragment into `anderton://pair?code=<code>&host=app.<suffix>`, and also tells the person they
   can paste the link into the app.
5. The app posts the code to `POST /v1/pair` and gets back a device key.

A code is 256 random bits, works once, and expires after 10 minutes. A person has one pending code at a time, so a
new one replaces the old. Codes live in host memory, by hash, so a host restart expires them.

The code travels in the URL fragment, so it never reaches tunnel logs and link unfurlers cannot read it. The trust
model is the one `ncl voice call` uses: the link speaks only as the person it is sent to and goes only to their DM.

A DM is not a vault, though: anything that can read it can read the code, such as an agent holding that person's own
user token. So redeeming a code DMs the person that a phone paired, and they can have any agent revoke it.

## Identity

A device key belongs to one `users.id`, such as `slack:U0EXAMPLE` or `discord:123456`, but each bot records people
under its own channel type, so one human can hold several ids. One pairing covers all of them that are the same person
beyond doubt: Slack ids whose bots registered the same teamId (`equivalentSlackUserIds`), and Discord ids with the same
raw id, which is global. On a call the person joins as the id a message typed in that channel would carry, when that
id has access, so their rights on a call are the ones they would have typing there. A second Slack workspace, or Slack
and Discord, stay separate pairings: the app keeps one key per pairing and merges the lists itself, and the server
never links those.

Keys are `nca_` plus 256 random bits in base64url, and only their sha256 hash is stored (`mobile_devices`,
[db-central.md](db-central.md)). There is no session: every request reads the device row and re-checks that the user
still exists, so revoking a device stops its key on the next request. Revoking reaches no further than the API: a call
link the device already holds still claims until it expires, and a phone already in a room stays until the person
loses access or the call ends. Thread visibility and call rights are evaluated per request too, with one exception
below.

`ncl mobile devices` lists devices: from an agent, those of the one person asking, under all their ids; from the host,
everyone's. `ncl mobile revoke --id <device>` revokes one, and an agent can only revoke a device of that same person.
From an agent both refuse when the host cannot tell who is asking, as with a request spoken on a call, because that
row names nobody. Neither ever prints a key. A phone can delete itself with `DELETE /v1/device`.

Asking an agent aloud on a call to revoke a device is unproven until someone uses that spoken route for real; the code
it calls was proven on the live host.

## API

JSON, with `Authorization: Bearer <key>` unless noted. Errors are `{ "error": "<sentence for a person>" }`. A missing
or unknown key gets 401, an unknown route 404, a body over 4 KB gets 413, and more than six call or new-thread requests
from a device in a minute get 429.

| Route                                  | Purpose                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /pair`                            | The page above. No key; the code is in the fragment.                                                                                         |
| `POST /v1/pair`                        | `{ code, label? }` to `{ key, deviceId, userName, platform }`. No key: the code is the credential. 410 for an unknown, used or expired code. |
| `DELETE /v1/device`                    | Deletes the calling device.                                                                                                                  |
| `GET /v1/threads`                      | Threads this person can call an agent in, and their own DMs, newest first, and their filters. Takes `?workgroup=<id>&channel=<id>&q=<text>`. |
| `POST /v1/threads`                     | `{ agentGroupId, messagingGroupId }` to a call link, in a new thread. See [New thread by call](#new-thread-by-call).                         |
| `GET /v1/places`                       | The agent and channel pairs this person can start a new thread in, most recently active first.                                               |
| `POST /v1/threads/:sessionId/call`     | Starts a group call in that thread, or joins the live one, as this person.                                                                   |
| `POST /v1/threads/:sessionId/dm-call` | In the person's own DM: a call with its agent, in a room only they may join. See [Calling from a DM](#calling-from-a-dm). |
| `GET /v1/threads/:threadKey/messages`  | The latest messages in that thread. See [Thread history](#thread-history).                                                                   |
| `POST /v1/threads/:threadKey/messages` | `{ text, sendId, files? }`, with the send key: replies in that thread as the person, or in Discord under their name. See [Replying in Slack](#replying-in-slack) and [Replying in Discord](#replying-in-discord). |
| `POST /v1/uploads`                     | One file's bytes, with the send key, to `{ uploadId }` for the reply that follows. See [Photos and files](#photos-and-files).                  |
| `POST /v1/slack/connect`               | A Slack sign-in link that connects this person for replying.                                                                                 |
| `GET /slack/oauth/callback`            | Slack's redirect after sign-in. No key; the state is the credential.                                                                         |
| `POST /v1/replies/enable`              | DMs this person a link that lets this device send. See [Turning on replies](#turning-on-replies).                                            |
| `GET /replies`                         | The page that link opens. No key; the claim is in the fragment and the page spends nothing.                                                  |
| `POST /v1/slack/claim`                 | `{ claim }` to `{ sendKey }`, only for the device that started the sign-in or asked for the link.                                            |

### Thread list

`GET /v1/threads` answers `{ threads, workgroups, channels }`, plus `textCutShort: true` when a search of message text
did not finish:

```ts
interface Thread {
  threadKey: string; // opaque and stable
  workgroupId: string;
  workgroupName: string;
  platform: 'slack' | 'discord';
  channelKey: string; // the `id` of its channel in `channels`
  channelName: string | null;
  title: string;
  lastActiveAt: string; // newest last_active across the thread's live sessions
  agents: { sessionId: string; agentGroupId: string; name: string }[]; // sorted by name; empty only in a DM
  dmWith?: string; // only on the person's own DM: the name of the agent it is with
  dmCalls?: { sessionId: string; agentGroupId: string; name: string }[]; // only on the person's own DM
  call: { sessionId: string; agentName: string; people: string[] } | null;
}

interface Channel {
  id: string; // the `channelKey` of `GET /v1/places`: opaque, shared by sibling bots, one per workgroup
  workgroupId: string;
  platform: 'slack' | 'discord';
  name: string | null; // as shown, `#general`, or `DM with Juniper` for the person's own DM
}
```

The app shows a Slack or Discord mark beside every channel it names, from `platform` on a thread, a channel and a
place. A pairing is one platform, so every row of one answer carries the same value; it is sent rather than inferred so
the app never has to know that. An app older than `platform` on a channel or place ignores it, and the app reads its
absence, from an older host, as no mark.

A row is one thread in one workgroup. A thread is its `thread_id`, or the `platform_id` for a session with no thread,
because sibling bots share both; two workgroups in one channel stay two rows. An agent group with no workgroup counts as
its own, with `workgroupId` `_agent-group:<id>` and its folder as the name. A workgroup's id starts with a lowercase
letter (the `workgroups` table's CHECK), so that id never names a workgroup, as the folder could; its first spawn gives
it a workgroup. An agent with two sessions in a thread appears once, on its
freshest usable session.

A thread has only the agents this person can call right now, and a thread left with none is not listed. An agent is
listed when its session is active and not archived, has a messaging group, is not a system or task thread, is in a
channel or thread rather than a DM, is on the person's own platform and, on Slack, in their own workspace; voice is
enabled for that agent group, group calls are configured on this host, the agent is still wired to that channel, the
person passes the same check typed messages do for that agent group under one of their ids, and the platform says they
can see that conversation. A failed visibility check drops that agent and never fails the list.

A scheduled task's session has no messaging group, so it reaches the list through the threads its posts started.
Delivery posts each day's first post of a task series at the channel's top level and threads the rest of that day's
posts under it; one series keeps one session for its whole life. Each such top-level post that something was posted
under lists the task's session in the thread it started, keyed by `<channel>:<post>` like any thread, and dated by that
post, so the list shows yesterday's thread beside today's and an old one drops off with the window. A post with nothing
under it is no thread yet: Discord opens one on it only when the first post under it lands, and until then says the
thread does not exist. Such a post stays in the channel's own row. `task_thread_anchors` keeps only each series' current
anchor per channel, so it names the sessions to look at and today's thread; the earlier ones come from the session's own
delivery record (`delivered`, the newest 2,000 rows within 90 days, read-only), which gives each post's platform id, and
the archive, which says the post landed at a channel's top level and whether any bot filed anything under it. The record
read is cached per session until the series' current anchor is not in it, or for five minutes. Every top-level post of
the session in that channel counts, so a routine outcome, a keyed post or an item of a series that opens one thread per
item lists as its own row too once something is under it. Every rule above holds for such a thread, with the thread as
its conversation: the agent is wired to the channel, and the platform shows the person that thread. Its title is the
first line of the post, unless the thread was named. A reply there posts into that thread, as in any thread. A task
anchored in the person's own DM adds no thread; its posts stay in the DM's own row.

A task's row offers its agent for a call by `<session>~<thread>`, the thread id `<channel>:<post>` in base64url, since
one task session posts many threads and a Slack post id is unique only within its channel. A Call there runs in the
thread's own session, the one a person's reply there would wake (agent, channel, `<channel>:<post>`): found, or opened
as `resolveSession` opens it for that reply, then marked active and engaged, as a call in a new thread is. From then on
the row offers that session. A wiring whose replies would not reach a thread session (threads off, or `agent-shared`)
answers 409; anyone who cannot see the thread gets the usual 404, and no session is opened for them.

A DM is listed only to the person in it, as a row with `dmWith` and no agents: a DM takes no group call, because group
calls start from a channel. Its `dmCalls` lists the agents there that the person can call from it: voice is on for the
agent, group calls are configured on the host, and the person's id in that DM passes the check typed messages do. Its
`call` stays null even while that call is live, because an app build without `dmCalls` would offer Join on the group
route. The proof that a DM is theirs is `ownDms` in `threads.ts`, the one test the list and the history
read both use. It reads `user_dms`, which holds the platform's own answer: the channel `openDM` returned for the person,
or the one the platform marked as a DM when they posted in it. The row must name one of the person's ids, as
`identitiesOf` holds them, and point at a one-to-one DM (a Slack `D` channel or a Discord `@me` one). Nothing else
counts: not a workgroup, a role or access to the agent, so an owner never sees someone else's DM, and a person who has
lost access to the agent still sees their own. Who is in a one-to-one DM never changes, so a DM takes no platform check
and no visibility cache, and calls need not be configured on the host. Its session must be active, not archived and not
a system or task thread, as in a channel.

The proof keys on the messaging group, never its channel id. `user_dms` keeps one DM per person and channel type, so
when a DM is opened again on a new channel the old one's threads leave the list. A group that copies another bot's DM
channel id carries no row of its own, so none of its sessions, titles or activity reach the DM's thread. A DM with no
row lists nothing until the person's next message in it records one; on this install on 2026-11-03 that was 6 of 22 DM
groups, five with no sessions and one cloned group last active in July. A Slack group DM is not a `D` channel, so it
never takes this path: it lists like any channel, for the people the platform says are in it. Discord bots cannot join
group DMs.

Without a search the list holds at most 100 threads with a live session active within 7 days. With `q` it holds at most
30, within 90 days. Limits count threads after those checks, so threads a person cannot use take no slots. The window
applies to the thread as a whole: any live session keeps it in, including an agent the row does not list, and a quiet
agent stays on a thread its sibling keeps busy. Closed sessions do not count.

`workgroup` narrows the list to that workgroup and `channel` to that channel, and both combine with `q`. Each filter
limits the wirings the list is built from, so an unknown id, or one this person has no access to, gives an empty
`threads` and never an error, and it can only ever narrow what they already have. A filtered list counts its own 100.
The app narrows the rows it already shows by `channelKey`, never by name, because sibling bots can hold different names
for one channel, as after a rename only one of them has seen.

`q` is trimmed and capped at 100 characters, and blank means no search. It is a case-insensitive substring match against
the generated title of any of the thread's sessions, the Discord thread title, the channel name as shown (`#general`),
and the name shown for an agent this person can call there. Case folding covers ASCII only, which is what SQLite `LIKE`
does. It is a bound parameter with `%`, `_` and the escape character escaped, and the text is never logged, though it
does travel in the URL, so anything logging URLs ahead of the host sees it. A match on one session brings the whole
thread. A search also reads message text, below, and those threads rank after the ones matched here, newest first.

### Search of message text

`q` also matches the words of archived messages. A hit only nominates a thread: it goes through every check above like
any other row, so a word can never bring in a thread the person could not see, and neither the matched text nor a
snippet comes back.

**Workgroups are tenants.** Each workgroup has its own FTS5 table in the archive, `archive_search_p<id>`
(`src/archive-search-index.ts`), and an agent group with no workgroup is a tenant of its own. A search reads only the
tenants the filter selects: with `workgroup`, that workgroup's table; without it, the table of every workgroup this
person can call an agent in. It never reads another tenant's rows, so what a search
costs, how many rows it reads, whether it is cut short and which checks it starts depend on the selected tenants' rows
alone. A word held only in another workgroup answers exactly as a word held nowhere: the same response, the same
visibility checks and the same archive statements. There is no owner path. An owner searches the workgroups they can
call in, like anyone else.

A message is indexed in the table of the workgroup its agent group is in when the message is archived: each archive
writer reads that from the central DB at the write (`archiveTenancyOf` in `src/archive-tenancy.ts`), and nothing ever
moves a row to another table. After an agent group moves from one workgroup to another, its earlier messages stay
searchable in the old workgroup only and its new ones in the new; nothing leaves the archive or the thread history. A
deleted agent group's messages stay in the table of the workgroup they were archived for, part of that workgroup's
history. A message of an agent group the central DB does not hold is archived but not indexed. A message archived before
an agent group's first spawn, while it has no workgroup, stays in that agent group's own table, which no search reads
once the spawn has put it in a workgroup.

**Inside a tenant, only checked channels.** A walk reads only the channels this person's last scheduled visibility check
passed. Every 15 minutes the `mobile-channel-visibility` sweep duty checks each paired person's wired channels, quiet
ones included, so a channel with no recent thread is still searched (`startChannelVisibilityRefresh` in `threads.ts`).
A channel is checked through each sibling bot wired to it in turn until one passes the person, so one bot's failure
costs nothing while another can read the channel; a person who cannot see it costs a check per bot.
In each Discord channel that passes, it then takes every thread the person's list could show there, by the list's own
rule for a search, and keeps its kind, once a bot has read it, for the life of the host process. A public thread goes
with its channel. A private thread is hidden from people who can see its channel, so its messages are searched only by
people its membership check passed: each person due in a refresh is checked once, through each sibling bot in turn
until one passes them, and the people checked in one refresh share the thread's guild, channel and thread reads. One
person's failed check leaves everyone else's result alone. A thread no bot can read is left out, and asked about again
at the next refresh. A Slack thread shows to everyone in its
channel and goes with it. A search never starts the scheduled refresh, and a word held only in a channel or Discord
thread the person was not checked for starts no check a miss would not. A thread the search does find goes through the list's own visibility checks like any listed thread:
an answer older than the 10-minute visibility cache is checked again. A channel or thread they join becomes searchable,
and one they leave stops being, at the next refresh. The filter rides inside the FTS `MATCH` as one token per channel
and one per Discord thread, so a channel or thread outside it returns no rows.

**Fail closed.** Until a person's first check has run, their list does no walk and sets `textCutShort`. After a host
restart that is until the first sweep tick, because the checks are kept in memory. A check that fails leaves that
channel or thread out until the next one. A check older than two refreshes, 30 minutes, authorizes nothing: when the
refresh fails or falls behind, the list does no walk and sets `textCutShort`, and one person's failed refresh does not
hold up anyone else's. Until the boot migration has completed, and again once other code has written the archive since
(below), search is off: the list does no walk and sets
`textCutShort` whatever the text, stop words alone included, and pre-turn context reports its archive read, and any
exact-link lookup, as failed.

**The person's own DMs** wait for no scheduled check. Each is searched with the list, in the table of its agent's
workgroup, because the record that admits it to the list (`ownDms`) is read in the same request. A person whose first
check has yet to run still searches their DMs, and the list sets `textCutShort` only when a channel was left unsearched.

A row counts under its tenant, not under the agent that archived it: a message any agent of the workgroup archived, in a
channel this person's check passed, finds that thread even when they cannot call that agent. The thread itself is still
listed only with agents they can call, and is dropped when there are none, unless it is their own DM. Each bot archives
its own copy of a message under its own messaging group, with the sender id prefixed by its own channel type. Copies
match on the platform channel, thread, time, role, text and the sender id after that prefix, the identity pre-turn
context collapses copies by (`archiveMessageKey`). A tenant's table holds one copy, carrying every copy's sender name,
and `archive_search_rows` records the others, so sibling copies cost one row: on a private copy of this install's
archive the tables hold 167,066 rows for 315,538 placed archive rows. A message older than the 90-day window never
counts, even in a thread that is still live.

One residual remains:

- **Timing inside a workgroup.** A word held only in a channel of the person's own workgroup that their check did not
  pass costs SQLite that word's doclist, which an absent word does not. On a private copy, at an earlier commit of this
  change (b28759879) whose walk reads the tables as this one does once its check passes, that made the walk alone
  0.55 ms slower at the median for a word held there in 56 rows (2.22 against 1.67 ms for an absent word), and no slower for one held in 4 (1.69 against 1.72 ms); the gap should grow with the word's rows there. Reopen
  this if a workgroup pairs someone who must not learn whether a word was said in one of its channels they are not in.

A message matches when it holds every term, in its body and never its sender's name. `archiveTextMatch` splits the text
on everything FTS5's tokenizer treats as a separator, drops the archive's stop words and any one-letter term, removes
repeats, keeps the first eight terms and quotes each one, so FTS syntax in the text is just more words and no term is a
phrase. Terms AND together, so a longer search only narrows. The last term matches as a prefix once it has three letters:
`branch` finds `branches`. Earlier terms match whole words, and the tokenizer does not stem. Text with nothing left to
search does no walk.

A session with no thread holds its channel's top level, so a reply in a thread of a `shared` channel finds nothing: the
hit names a thread no session holds. One live wiring is in that mode today.

The walk runs on a worker thread with its own read-only connection (`src/modules/mobile/text-walk.ts`), one tenant at a
time, newest first, 1,000 rows to a statement, and stops at 120 threads per tenant or at the end of the word's rows, so
one workgroup's matches never crowd out another's. A row older than the window counts for nothing but does not stop the
walk: recovery can archive an old message after newer ones, so rowids do not follow dates. The 120 count threads before
the list's own checks, so a thread the list then drops still uses one up.

**Keeping the index.** Every archive write indexes its row in the same transaction (`writeArchiveRow`), so a row and its
index entry land together or not at all. The writers are the router for inbound messages, delivery for an agent's
replies and the agent-to-agent route; each reads its agent group's workgroup from the central DB right before the write
and passes it in. An edit keeps the row in the table it was first indexed in. A write finds the message's other copies
through `idx_archive_message` (`platform_id`, `sent_at`). While search is off (below), a write leaves the tables
alone. The transaction is immediate, so a write
that meets another writer waits for it rather than failing at once; the host's archive connection waits at most 5
seconds, better-sqlite3's default busy timeout.

**Boot migration.** The first boot on this code indexes every archived row in the table of the workgroup its agent group
is in at that boot, before session adoption, the channel adapters and the sweep start (`migrateArchiveSearchAtBoot`,
`src/main.ts`). On a private copy of this install's archive (315,637 rows) it took 13.1 seconds at a load average of
2.25 and built 7 tables. Building `idx_archive_message` before it took 1.1 seconds and 19.7 MB. The boot waits for both.
The file grew by 95.5 MB: the tables' 70.7 MB, `idx_archive_message`'s 19.7 MB, `archive_search_rows`' 3.3 MB and a few
free pages. The global index's 116.7 MB stays (below). Until the migration completes, search is off and writes leave the
tables alone, so what an attempt that fails placed is never read: the next boot drops it and places every row again, by
the central DB at that boot. A failure logs `Archive search migration failed` and the host starts anyway; search is then
on only if the tables already held every row and edit. 99 rows of 12 agent groups absent from the central DB belong to
no tenant and are not indexed; no search could reach them before either.

**The global index stays.** Nothing reads `messages_archive_fts` now, but the archive keeps it and its three triggers
exactly as the code before this change made them, so that code can be started again on this archive with nothing to
rebuild, by hand or by the deploy crash guard (`src/deploy-crash-guard.ts`). That code writes the archive and the global
index but not the tables. So every search and every write of this code first checks whether other code wrote the archive
since this code last did: an insert leaves the archive's last rowid above every row this code accounted for, and an edit
raises the total of `archive_row_marks`, which that code's own triggers keep. Until a boot has placed every row again,
as after a failed migration, search is off and this code's writes leave the tables alone, so a later write of its own
cannot cover what the older code wrote. The boot places every row rather than the changed ones by choice: the marks
say only that an agent group's rows changed, not which, and a full placement rebuilds each message's copies and their
sender names with it. Those rows then go by the central DB at that boot, so a message archived before its agent group
moved can change table. Started on an archive whose global index a later change dropped, this code creates the index,
its triggers and its contents in one transaction when it opens the archive, before anything writes, so a fill that fails
leaves the index missing and the next open tries again. On a private copy of this install's archive (315,637 rows) that
open took 7.7 seconds at a load average of 17.08; it happens only after such a rollback. Keeping the global index
costs its 116.7 MB and its full-text write on every archive write, beside the tables'. A later change drops it.

These facts shape the walk, measured on this install's archive, read-only or on a private copy:

- **Being off the main thread is not enough.** The archive is in rollback-journal mode, so a reader's lock blocks every
  archive write, and those run on the main thread. One statement that scanned the archive on a worker held main-thread
  writes for up to 672 ms. On a private copy, with one insert at a time into the largest workgroup, a 5 ms sleep after
  each, and four walks running non-stop, the mean insert was 16.4 to 19.3 ms in 6 runs at an earlier commit of this
  change (2a1da6353), before each write also checked for other code's writes, a check of about 51 µs, against
  9.7 to 11.7 ms before this change. The tables' walks finish faster, so the same four walkers ran 2,994 to 3,790
  walks a run against 1,448 to 1,862, each holding the read lock an insert waits on, and 0.7% to 2.1% of them,
  against 0.5% to 2.1%, waited 200 ms for the lock and gave up: 26 to 65 walks a run against
  8 to 30. With no walks the mean insert was 4.9 to 6.9 ms against 4.3 to 5.6 ms: the tables' write comes on top
  of the global index's, which this change keeps.
- **`LIMIT` bounds rows, not work.** A phrase of 50 common tokens scanned its whole doclist in one statement: about 540 ms
  and no rows. So every quoted term is one token, and a test holds that against the tokenizer for every letter and digit.
- **`Worker.terminate()` cannot stop a statement.** It waited 8.9 seconds for a running query to end. better-sqlite3
  exposes no interrupt, so the statement size is also how soon a walk can be stopped.
- **A prefix costs a full merge on every statement**, because the tables have no prefix index. So one prefix per search,
  and none under three letters. On the largest workgroup's table, over all its channels, at b28759879, the slowest of 1,695
  three-letter prefixes took 45 ms for its first statement, and the median 4.2 ms. Re-raise
  this if any statement passes 200 ms.

The host gives the walk 1.5 seconds. At the limit the list answers with the title matches plus whatever the walk had
found, sets `textCutShort`, and terminates the worker, which ends once its current statement returns. At most four walks
run at once, a cut-off one counting until it exits, and a search past that is cut short at once. A device gets 60 walks a
minute, counted only for a list that would walk, and past that the list is cut short with no walk. Someone typing stays
under it: the app sends a list per 300 ms pause and one every 15 seconds. A walk that waits 200 ms for the file lock, or
fails any other way, counts as cut short and logs `Mobile: text search failed` with SQLite's code only, because its message
quotes the query. The app reads `textCutShort` to avoid saying nothing was found and, when the list has rows, to say they
are the matches found so far.

`workgroups` is every workgroup this person can call an agent in, or holds a DM of theirs with an agent, on this
pairing's platform and workspace, sorted by name, whether or not it has a thread in the window. It ignores `workgroup`
and `q`, so the picker stays complete while filtered, and it comes from the central DB alone: no session DB and no
platform read. So it can name a workgroup whose channels the person turns out not to see.

`channels` also ignores the filters and starts no platform read. It offers each of the person's own DMs as `DM with` its
agent's name, never by the DM's own name, which is the person's: the proof above admits it, with no check and no thread
needed, and choosing it lists only that DM's threads. Other channels it lists only where a visibility check has passed
for this person in the last 24 hours, on the list, in the New call picker or in the scheduled check that search uses. A
member of an agent group need not be in every channel it is wired to, so the wirings alone would name private channels
to people who are not in them. That memory is per person and lost on a restart, until the first sweep tick checks their
channels again. It decides only what the filter offers: the threads of a channel still pass the checks above. Which
platforms offer the filter is `CHANNEL_FILTER_PLATFORMS` in `threads.ts`. The app offers channels in its scope sheet,
below, once a workgroup is chosen, or the person has only one, when that workgroup lists more than one channel.

Each visibility answer is cached in memory per place, channel type and person for 10 minutes, so listing does not page
Slack on every poll. A failed check is kept for one minute. This cache only decides what the list shows: for up to 10
minutes after someone leaves a channel the list can still show its threads, including the title of one started after
they left, but the call endpoint never reads it.

A list starts at most 40 new checks, and every Discord thread is its own place, so a first list can be short and fill
in over the next polls. Within one list Discord guild, channel and member reads are shared. All Discord reads, live
ones included, keep to 20 a second per bot, a 429 holds the next read past its `Retry-After`, and a read that would
wait longer than its timeout fails closed. On a Discord rate limit a live call's minute check skips only its Discord
half instead of ending the call, because a 429 says nothing about who can see the channel; the access check against the
central DB still runs. Slack has no such skip.

A row's `title` is, in order: the freshest generated `sessions.title` among all the row's sessions, listed or not and
closed ones included, by `title_generated_at` (the console's rule, `freshestGeneratedTitle`); the Discord thread title;
the earliest human message with platform mentions stripped, skipping a replayed `[Thread context]` block (read once from
an inbound DB and cached in memory; a session with no human words yet is read again at most every five minutes); the
channel name; "DM with" the agent's name, in a DM; "Thread". Only a thread with neither title opens a session DB, and
the sweep titles nearly every thread.

`call` is null unless someone is in the room, and only ever names a session this person can use, so `Join` works. A
group call stays open for three minutes after the last person leaves, and that empty room reads as no call: the app
shows a plain Call button, and `POST /v1/threads/:sessionId/call` joins the room that is still open, so nothing is lost.

Visibility checks get eight seconds per list. A check still running then drops out of that response and finishes into the
cache, and threads the list had not reached wait with it, so they appear on later polls rather than the whole list missing
the app's 30-second limit. Finished and cached answers are kept. A list waiting past five seconds logs
`Mobile: thread list is slow` with the stage it reached, and a list that took that long logs
`Mobile: thread list took too long` with the milliseconds per stage. SQLite reads hold the event loop, so only the second
line covers title reads. A synchronous read that never returns logs neither.

A thread with someone in the room is listed whatever its age, ahead of the limit, because opening a call writes nothing
to `last_active`: without that, a call started on a thread found by search would show no Live row on anyone's list.

### Thread history

`GET /v1/threads/:threadKey/messages` answers `{ messages }`, oldest first, from the archive:

```ts
interface Message {
  id: string; // opaque, and the same on every read
  speaker: string;
  fromAgent: boolean; // an agent's post, not a person's or another app's
  spoken: boolean; // said on a call: the words a speech model heard, posted by the agent's bot
  text: string;
  sentAt: string;
}
```

A thread can be read only when a call in it would be accepted right now, or it is the person's own DM. The host finds
the row's thread among the live sessions of the wirings this person can call and of their own DMs. A DM passes on the
proof above, read afresh. Otherwise the host asks `POST /v1/threads/:sessionId/call`'s own check of each agent there,
freshest first, until one passes: a fresh platform check, never the list's cache. Anything else answers that route's
404, with its body, so a key that names no thread and a thread the person has lost read the same. A device gets 30 reads
a minute, and past that a 429, because each read asks the platform. The app keeps reading after a 404, which a platform
check that fails for a moment also answers, and stops on a 401.

The read takes the newest 200 archive rows of each agent the person can call there and shows the newest 100 messages.
Text only: no files, images, reactions or edits, and a message the platform deleted still shows, because the archive
keeps it. Secrets are scrubbed as they are for a call's context. A session with no thread reads its channel's top level,
without the task posts that open listed threads: the archive keeps such a post at the top level, and it shows in the
task's own thread instead, above the posts under it. It still collapses the copies sibling bots archived of it. A task
post that opens no listed thread, such as one from a series that never anchors in that channel, stays at the top level,
and a DM's top level keeps a task's posts.
A session whose thread id is its channel's own id, as a Discord DM's is, reads both, 200 rows each: the archive holds
the person's messages under that id and the agent's replies with no thread. On the one Discord DM in this install's
archive, 24 of the agent's 25 replies had no thread.

A mention reads as the name the host already holds for its id: an agent's bot by the name its adapter registered, else a
person by their `users` row (`display_name`). That covers `<@id>`, Discord's `<@!id>`, Slack's `<@id|label>` and the
bare `@id` Discord's adapter archives for what people post. A Slack id is named only from the thread's own workspace,
because the same raw id can name someone else in another. An id neither knows, a role or channel mention, an address,
and anything in single-backtick inline code or a triple-backtick fence stay as written, and nothing asks a platform. It
changes only what the app shows; the archive keeps the text as it was.

Each message shows once:

- **What people post.** Every bot archives its own copy, and copies collapse on the archive's sibling key: the platform
  channel, thread, time, text and sender id without its prefix. Copies whose text differs, as when two bots render a
  mention differently, stay separate; on this install's archive that was 2 of 10,573 messages with two copies in 30 days.
- **What agents post.** Delivery archives an agent's post as that agent's own record once the platform has answered. Each
  sibling that receives the post archives it again as a message from the agent's bot, earlier and often in other words,
  after Slack's markdown conversion or Discord's split: among copies whose text matched their record exactly, 59 ms to
  13 s earlier over 30 days. Text cannot match the rest: 6,343 such copies sat within 30 seconds before another agent's
  post, and only about 2,500 matched it by text. So a copy from one of our bots is dropped when an agent read here,
  posting as that bot, recorded any post in the 20 seconds after it. Counting every agent as read, that dropped 28,680 of
  37,133 copies from our bots in threads over 30 days. Until an adapter has registered its bot, its agent's posts can
  show twice, and a read that lands between a sibling's copy and the agent's record shows the copy, under the bot's name,
  until the next read.
- **What nobody archives as their own.** Delivery records only plain chat posts. A card such as an agent's question, an
  approval request, a call note or a call's mirror reaches the archive only as siblings' copies, and so does the post of
  an agent that is not read, such as one with voice calls off. Such a copy shows, under the bot's name, unless an agent
  read here posting as that bot recorded any post in the 20 seconds after it: then it is dropped like a copy, which hides
  a call's start note the agent answers at once, or the post of an unread agent that shares a bot with one that answered.
  8,075 of the 37,133 copies had no record within 30 seconds and show. At most 150 had their record land 20 to 30 seconds
  later; any of those that is the copy of that post shows twice. A thread with one agent has no copies, so it shows none
  of these.
- **Call mirrors.** A mirror (`🎙️ Name (voice): words`) shows as the caller's words, marked `spoken`, but only from one of
  our bots. The same text typed by a person shows as typed. A read agent's post that only looks like a mirror has its own
  mirror-shaped record within 20 seconds, so its copy is dropped and the post shows as the agent's; that also drops a real
  mirror the same agent follows with a mirror-shaped post inside the window. From an agent that is not read, or one
  whose record lands later, a look-alike still shows as the caller's words. The fix is for the voice module to archive
  the mirrors it posts.

Relay wrappers (`[Voice call]`, `[Group voice call]` with `<request>`) and a replayed thread history that opens a message
are how an agent was told; only the words inside show, and only in what people post. The archive held none of them on
2026-11-02, but nothing stops a writer from archiving one.

`sentAt` is UTC, and the app shows it in the phone's own zone, which is where its reader is, rather than the install's.

The answer also carries `reply` when the app can reply in this thread: `ready` once this device holds a send key, and
before that the step that gets one, `connect` for Slack or `enable` for Discord. `unlock` names that step even when the
host says `ready`, for a phone that lost its own copy of the key, and `replyTo` names the agent a Discord reply goes to.
It is absent everywhere else: a channel's top level, a Discord DM, a Slack workspace other than the one replying is set
up for, a Discord thread the person could not post in, or a host with replying off. See
[Replying in Slack](#replying-in-slack) and [Replying in Discord](#replying-in-discord).

Over Slack the archive's text is standard markdown, and the app shows it as formatting (`mobile/src/markdown.ts`, on
marked's lexer): headings, emphasis, code, lists, blockquotes, rules and links. A link opens only for `http:`, `https:`
and `mailto:`, and any other scheme shows as plain text. Inline HTML tags show as written with markdown read between
them, and a block of HTML shows entirely as written. An image shows as its description linked to it and never loads. A
table shows as a grid: an emphasized header row, hairline borders, each column's alignment, and inline formatting in its
cells. Each column is sized to its widest cell, estimated from character counts with wide characters and emoji counted
twice (`mobile/src/table.ts`), between 44 and 220 dp, and a longer cell wraps. A table wider than the screen scrolls
sideways inside the message. Once a message's tables pass 200 cells in all, the rest show as their rows in monospace
instead, because each cell is a native view; the largest real table since 2026-10-20 had 36. Two pieces of Discord
markdown show too: a line starting with `-# ` is small, muted subtext; and a timestamp `<t:UNIX>` or `<t:UNIX:STYLE>`
(`t`, `T`, `d`, `D`, `f`, `F`, `R`) shows in the phone's own zone in Discord's English styles, `R` relative to when the
message is drawn. A timestamp with another style letter, or outside the range of a JavaScript date, stays as written,
and so does one in code. marked has no `-# ` line, so an extension to its lexer adds one: a paragraph, table or setext
heading stops at a `-# ` line, which is a block of its own, like a heading, so emphasis or a code span does not run
across it. Under a list item it belongs to the item, as any other line there would, and in fenced code or a block of
HTML it stays as written. Because marked's lexer is superlinear on some shapes and parses on the JS thread, a message
past 5,000 characters, 400 lines, a 1,000-character word or 16 characters of leading quote and list markers on a line is
not parsed. It shows instead as best-effort readable plain text, with its markdown markers stripped in one linear pass:
emphasis, code and heading markers, fences and quote markers go, a link or image keeps its label when it closes on its
own line, a bullet marker becomes a bullet, and code stays code. That pass may drop an unmatched `*` or `_`, and does
not see a fence inside a quote. Nesting past eight levels shows as plain text the same way. Long messages lose rich
formatting by design. Showing a message never throws: if the lexer or the strip throws, the next one down shows, and
last of all the text itself. Under those limits the costliest input measured, nested emphasis in one 5,000-character
paragraph, took 1.6 to 2.0 s on the Hermes 0.13 VM on the host, which is accepted. Of 18,491 Slack messages from
2026-10-20 to 2026-11-03, 15 (0.08%) were over 5,000 characters, all agent reports, and none exceeded any other limit.

Measured on a private copy of this install's archive (746 MB) on 2026-11-02 and 03, through the real read, in four runs
on this host at a load average near 5: the 430 threads with rows in the last 7 days took about 1 ms at p50, 3 to 5 ms at
p90 and 18 to 81 ms at most, and the 8 channel top levels in use 11 to 19 ms at p50 and 18 to 49 ms at most. Finding the thread from its key, for a person wired to all 117 channels with 3,329 live sessions,
took 13 to 14 ms at p50 and 28 ms at most on a copy of the central DB. The read runs on the main thread: a reader's lock
holds archive writes, and at these sizes it holds them for milliseconds. The per-agent read used to reach a thread by one
`OR` of its two shapes, which walked the agent's whole archive (315 ms p50, 510 ms at most); it now picks one statement per
shape, so each walks `idx_archive_thread`, which also speeds the archive context a call opens with. A response was about 1.4 KB
at p50, 39 to 44 KB at p90 and 201 KB at most. Re-measure if a read's p90 passes 50 ms.

### Calling

`POST /v1/threads/:sessionId/call` answers `{ url, agentName, joined, expiresAt }`. It follows the same rules as a call
asked for in the thread, through the same code path (`openOrFindCall` in `src/modules/voice-call/group/service.ts`),
with three differences: the person is the one the key belongs to rather than the thread's latest human, the route
comes from the session and its messaging group, and the link comes back in the response instead of a DM. A call
started from the app still posts the normal start note to the thread.

A session the person cannot see answers the same 404, with the same body, as one that does not exist. Timing can still
differ, because a real session takes a platform check; that only reveals that an id exists, and ids are not guessable.
Refusals
answer 409 with a sentence: not enabled, too many live calls, not allowed, or already on the call. The app has no
direct-call fallback when the host is at its limit.

Access is checked live, on every call request, against the platform and the central DB. After that the app uses the
endpoints a browser uses, unchanged: `POST <url>/claim` with `Origin: <url>` returns `{ token, url, pageToken }`, the
LiveKit client connects with those, `GET <url>/events?t=<pageToken>` streams transcript and people, and
`POST <url>/leave?t=<pageToken>` leaves. The `Origin` check defends browsers against sibling previews, and a native
client setting that header is fine.

### Calling from a DM

`POST /v1/threads/:sessionId/dm-call` answers `{ url, agentName, joined, expiresAt }`, the same link
`POST /v1/threads/:sessionId/call` gives, joined the same way: a LiveKit room the agent's voice bridge joins, so the
call screen, the lock screen and the call notification work as in a channel. The session is admitted only by
`ownDms`, as the list and the history read admit a DM: it must be in the person's own DM, active, and its agent still
wired there; anything else answers the same 404 as a session that does not exist. The caller is the person's own id in
that DM, from `user_dms`, never anyone a message names.

The room is `startOrJoinDmCallAs` in `src/modules/voice-call/group/service.ts`, a DM place beside the channel places.
Who may join it is exactly that person: anyone else, asking or invited by the agent, is refused, and the minute check
keeps only them. It hears the DM, and what is said on it posts into the DM as a channel call's does, with no start note
inviting others. A room of theirs with that agent already live, from any thread of the DM, is joined rather than a
second opened. A live call in a channel is not joined from the DM: the person joins that one from its own row. Refusals
answer 409 with a sentence, as in a channel. The group-call entry points (`POST /v1/threads/:sessionId/call`,
`ncl voice call --group-call`) still refuse a DM.

`ncl voice call` asked in a DM while that person's room is live hands them a link to it (`joinFromDm` finds it); with
no room live it stays the browser direct call [voice-call.md](voice-call.md) describes. An app build without this
ignores `dmCalls`, so it shows no Call button in a DM.

### New thread by call

`POST /v1/threads` opens a thread in a channel and starts a group call in it. The answer is the same
`{ url, agentName, joined, expiresAt }` as `POST /v1/threads/:sessionId/call`, and the app joins through the same path.

Access is the rule above, with no session yet: the agent is wired to the channel, the channel is on the person's own
platform and workspace and is not a DM, they pass `mayCall`, and the platform says they can see the channel, asked live
and never of the list's cache. Everything refused for those reasons answers the same 404. Voice off for the agent, or a
host at its call limit, answers 409 before anything is posted.

The device sends two ids and no words. The parent post, the thread title and the first message are fixed strings the host
builds from the person's display name and the agent's name, so nothing the device sends reaches a platform post.

The request creates the session for that agent, channel and thread, per-thread whatever the wiring's `session_mode`, then
opens the call through `openOrFindCall`. No task is created and no message is written: the agent wakes on the first
request spoken to it, on the call's own inject path, which needs only the session's mailbox. The thread is marked engaged,
so a follow-up typed in it reaches the agent as it would in a thread the agent was mentioned in.

The thread starts as `Call with <agent>`, stored in `thread_titles` with source `auto`, and every list shows that row's
title. The title sweep names it once a message with `trigger = 1` lands, within two ticks, and for the thread's first hour
can rename it up to three times, five minutes apart, while the title does not yet name the subject: on Discord through the
adapter, on Slack in the row alone, since a Slack thread has no name. After that hour a titled row settles and does not
change again. A first title has 24 hours from the thread's creation, so a long outage of the generator does not leave the
thread on its fixed name. A call nobody spoke to the agent on keeps that name.

A title reads every session in the thread and names what the conversation is about, never the medium: the first message
from a person, what a link's preview says, the first reply long enough to carry the subject, up to 600 characters, and the
last three messages from people. Status rows and agent sign-offs stay out, and for a voice relay it reads the words inside
`<request>`. A first message with a link or file and 50 words or fewer of its own may be leaning on it for a subject, so it
waits for that reply: up to 30 minutes, after which the title comes from what is there and a later turn can improve it.
Discord shows the thread's stand-in name for as long as that takes.

A thread with no row shows its sessions' freshest title. Those keep refreshing, except on task sessions, for a session
active in the last day: at most once an hour, only after 10 new messages, and one refresh a tick across the host. A refresh
keeps a title that names a subject, so it changes a name only when the name says nothing about the subject.

Someone who wants a particular name asks the agent, typed or on the call, and the agent runs `ncl threads rename --title
<name>`. The host takes the thread from the session, so an agent can name only the thread it is in. The name is pinned, so
the sweep leaves it alone, and it beats whatever the thread was called before, a person's name included. On Discord it
renames the real thread as the bot that owns it; if Discord refuses, the thread keeps its name and the agent hears why. On
Slack, where threads have no name, it changes the title in this list only.

A device gets one new thread a minute and 20 a day, and past that a 429. Only a request about to post counts, so a refused
one spends nothing, and a post that fails still counts because it may have left a parent behind. The counts live in host
memory: a restart forgets them, so a device can open a thread right after one, and at most 20 more that day per restart.

A post cannot be taken back, so these are what a failure leaves behind:

- **The parent posts and the thread does not:** the parent stays in the channel with no thread under it. The answer is a
  502, and `open thread: could not open a thread` is logged.
- **The thread posts and the call does not start:** the parent, the thread and, once it was created, the session stay, and
  the thread is on the list under its fixed name, where anyone can call in it. A person sees that the thread stays and the
  call did not start, a 409 quoting the refusal or a 502 otherwise, and
  `Mobile: a new thread was posted but its call did not start` is logged with the agent, channel and thread.
- **The call opens and nobody joins:** it ends after ten minutes like any other, with its normal note in the thread.

`GET /v1/places` answers `{ places }`:

```ts
interface Place {
  channelKey: string; // opaque; sibling bots in one channel share it, and two workgroups in one channel do not
  agentGroupId: string;
  agentName: string;
  messagingGroupId: string;
  platform: 'slack' | 'discord';
  channelName: string | null;
  workgroupName: string;
  lastActiveAt: string | null; // newest last_active of that agent's sessions there, closed ones included
}
```

The screen filters these rows on the phone, by workgroup chip and by channel name, so this route is unchanged. A place
carries `workgroupName` and no id, so the chips go by name and two workgroups with one name share a chip. They start on
the workgroup chosen on the thread list and neither filter outlives the screen.

It holds at most 50 rows, from the same wirings as the list, minus any where a typed reply in a new thread would miss that
thread's session by the router's rule: threads off, `agent-shared`, or a wiring outside a group that is not `per-thread`.
The POST refuses those too, before anything posts. Each channel is checked through the list's visibility cache with the
list's budget, so a first read can be short. The picker asks each pairing again every 15 seconds while it is open, so it
fills in; a pairing that hangs or fails holds up no other, and a failed one keeps the rows it last gave. A row is only a
suggestion: the POST checks everything again. It is its own route so that `GET /v1/threads` keeps its shape for
an app older than the host. An older app never asks for it.

## Replying in Slack

A person replies in a Slack thread from the app as themselves, under their own Slack user token: the post carries their
name and avatar, and Slack delivers it like anything they type. Text only: no edits, reactions or files. Discord works
differently: see [Replying in Discord](#replying-in-discord).

Which token posts is chosen by the person's workspace, never by who they are. In the workspace the send app is installed
in, it is only the token the person connected (below); an owner's or a group's token is never used there. In any other
workspace, it is a user token one of the thread's agent groups already holds, used only once Slack says it is the
person's own: see [A workspace with no send app](#a-workspace-with-no-send-app).

The send app is a small Slack app of its own, separate from every bot, that asks for the one user scope `chat:write`, is
installed in one workspace and is not distributed. `.env` names it: `MOBILE_SLACK_SEND_CLIENT_ID`, and
`MOBILE_SLACK_SEND_TEAM_ID` for the workspace, read by `src/modules/mobile/slack-send.ts`. Either empty turns replying
off in that workspace. Its client id and secret are one HTTP Basic value in the vault, `approved-run-slack-send-oauth token`, injected
only on `slack.com/api/oauth.v2.access` and only for that reserved agent, so the host never holds them. Slack's
redirect URL is `https://app.<suffix>/slack/oauth/callback`.

### Connecting

1. The app asks `POST /v1/slack/connect` with its read key. The host refuses unless the pairing's person is a Slack user
   of the configured workspace, as one of their ids on a bot of that workspace, then answers a Slack sign-in link for
   `user_scope=chat:write,files:write`, pinned to that workspace. The device names nobody.
2. The person signs in to Slack in the browser. Slack redirects to `GET /slack/oauth/callback` with the code and the
   state. A state is 256 random bits, kept by hash in memory for ten minutes, spent on first use, and one device has
   one at a time. A device gets three a minute and 20 a day.
3. The host exchanges the code through the gateway as the OAuth agent. It keeps the token only when Slack says it
   belongs to the same person, in the same workspace, with `chat:write`, and does not expire; anything else is revoked
   at Slack and nothing is stored. The token goes into the vault as one entry,
   `approved-run-slack-send-<team>-<user> token`, injected on `slack.com/api/*` and only for that person's own
   reserved agent. What it can do there is its own scopes, `chat:write` and `files:write`, and the four calls the
   host's reply client has (`SlackReplyApi` in `src/slack-user-api.ts`: `chat.postMessage`, `auth.test`,
   `files.getUploadURLExternal`, `files.completeUploadExternal`). Granted `chat:write` alone, the token still posts
   words, and a file asks for a reconnect. Reserved names (`src/reserved-secrets.ts`) cannot be granted to any agent
   group or workgroup by `ncl secrets grant`, a spawn whose `container.json` or workgroup declares one aborts, no
   container can run as their agent, and the approved-run token guard removes any other grant within ten minutes. The
   token passes through host memory between Slack's answer and the vault write, and is never logged or stored anywhere
   else. Connecting again replaces the value, and moves an entry stored on an older path to `/api/*`.
4. The page answers as soon as that check passes, without waiting for the vault write: checking that only the
   person's agent holds the token reads every OneCLI agent's effective credentials, which the control API answers one
   at a time, so it takes about ten seconds per check, one on a first connect and two on a reconnect. The page links back to the app with a one-time claim
   ("Tap Open Anderton to finish"), and also opens that link itself; Android Chrome follows it without asking only
   within 15 seconds of the tap on Slack's Allow. Loading the same redirect again while the claim lives, as Chrome does
   when it comes back to the tab after opening the app, shows the same page and claim rather than a spent sign-in. The
   person is told in their DM that a phone connected once the token is stored.
5. The app redeems the claim at `POST /v1/slack/claim` with its read key. Only the device that started the sign-in can
   redeem it; another device's attempt does not spend it. The host issues the send key only once the token is stored
   and both holder checks have passed, waiting up to 20 seconds for that, well inside the app's 30-second request
   timeout. Still unsettled, it answers 503 and leaves the claim unspent, and the app asks again by itself every three
   seconds, four times, as it does when an answer never arrives. If the claim is still unsettled after that, the app
   keeps it and the thread offers Finish connecting Slack, which asks again without the browser, since the browser tab
   may no longer show Open Anderton; tapping Open Anderton again does the same. Once the
   claim yields a key, every request for it from that device in the next two minutes, overlapping or later, gets the same
   key, so a phone whose answer was cut off, or that the link opened twice, still ends up holding the key the host
   recorded, as long as it is still the device's current key; the key stays in host memory for those two minutes only.
   A failed store spends the claim and answers 503 with the reason and `final`, so the app does not ask again, "The host could not finish setting up sending. Try
   again in a few minutes." when OneCLI refused a write; the person connects again. Both store paths wait on OneCLI's
   control API: a first connect's grant, and a reconnect's two holder scans (each about ten seconds in production, so a
   reconnect can outlast the host's 20-second wait, which the app's retries and Finish connecting Slack cover). A OneCLI
   outage is not covered: the store fails, and the phone is told to try again later. The store runs in host memory, so a host restart mid-store loses the
   claim, and the person connects again. Each claim request logs one line, `Mobile: send key claim`, with its outcome
   (`redeemed`, `replayed`, `unsettled`, `failed`, `expired` or `unknown`) and how long it waited, and never the claim
   or the key.

The send key is the device's second key: `ncs_` plus 256 random bits, kept on the host only as a hash in
`mobile_devices.send_key_hash`. It opens only the reply route, and the read key never opens that route. Revoking the
device deletes the row, and both keys with it. Connecting again replaces the send key. The person's token stays in the
vault after a device is revoked, because it is theirs rather than the device's, and is useless without a send key.

So a read key alone never sends. Getting a send key also takes a Slack sign-in as that same person, in a browser, and
the claim reaches only the browser that signed in. A pairing link, which anything that can read the person's DM can
read, therefore never yields one.

On the phone the send key is kept with `expo-secure-store`, under its own keychain service, `anderton.send.unlocked`,
and sending asks for nothing. On iOS it is a Keychain item on this device only, readable while the phone is unlocked,
in the class that needs a passcode (`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, the class the biometric item used): a phone
with no passcode cannot keep one, and removing the passcode deletes it. On Android it is encrypted with an app-private
Android Keystore key, readable by the app whenever it runs: `keychainAccessible` is iOS-only, and `expo-secure-store`
offers no unlocked-device requirement on Android short of biometrics. Either way the phone's own lock and its app
sandbox are what guard it.

It never leaves the phone. On iOS the item is not synchronizable (`expo-secure-store` sets no
`kSecAttrSynchronizable`), so it is not synced to iCloud Keychain, and its class is left out of every backup, so no
backup holds it, not even one only this phone could restore. On
Android the values sit in the `SecureStore` shared preferences, encrypted with Keystore keys that never leave the
device, and `expo-secure-store`'s config plugin, enabled in `app.json` with its backup rules on, excludes that file from
cloud backup and device transfer (`android:fullBackupContent` and `android:dataExtractionRules`). Revoking or deleting
the device on the host deletes the row that holds the send key's hash, so a copy of the key would not send anyway.

Earlier builds kept it behind biometrics (`requireAuthentication`, service `anderton.send`). The first send after the
update reads that item once, which asks for Face ID or a fingerprint that one time, stores the key in the new item and
deletes the old one (`movingVault`, `mobile/src/accounts.ts`). A cancelled or failed prompt sends nothing and moves
nothing, and the next send asks again. An old copy whose delete failed is deleted on a later read without being read.
Reads, replacements and deletes of one key run one at a time, so a key forgotten or replaced while the prompt is up is
not brought back. An old item biometrics no longer open (a face or fingerprint was added) reads as
no key, and the app offers Connect Slack again. That one read is why `app.json` keeps `NSFaceIDUsageDescription`.

### A workspace with no send app

A person paired as a Slack user of a workspace with no send app gets a send key the way a Discord person does: **Enable
replies** DMs them a one-tap link through that workspace's bot ([Turning on replies](#turning-on-replies)). The key is
per paired account, so an account whose key came from Connect in another workspace still needs its own.

The words post through the OneCLI identity of one of the thread's agent groups: the group's own identity, the one its
owner-safe sessions run as, never the `-noslack` one. Candidates are only the groups of agents the person can call in
that thread whose bots are in the person's workspace. Each send, a group counts only when all of these hold, read
afresh:

- The secrets the gateway would inject for that identity include exactly one that could match `slack.com`, and its host
  is exactly `slack.com`. A second one, or one whose host is a wildcard or that the vault no longer lists, could be the
  token a call actually carries, so it fails. A token for another host, such as `files.slack.com`, does not count.
- That one secret is a Slack user token the group declares (`slack_user_token`, over its own and its workgroup's
  secrets, as the spawn computes it).
- Slack's `auth.test` through that identity names this person, in this workspace. No answer, an error, or another
  person or workspace fails.

A group whose config or held secrets cannot be read is skipped for the next candidate, and the screen does not reuse
that failure.

The reply goes through the transport's fixed `https://slack.com/api/` origin with manual redirects, and the route's
client (`SlackReplyApi`) has only `auth.test`, `chat.postMessage` and, for [files](#photos-and-files),
`files.getUploadURLExternal` and `files.completeUploadExternal`, so no other secret that identity holds is reachable
from here. The
secret's own path rule covers everything under `/api/`; the code is the path limit. A thread screen may reuse a proof
for five minutes to decide whether to show the reply box; a send never does.

The identity holds the token only after an owner-safe session of that group has spawned since the grant; until then
`auth.test` fails and there is no reply box. OneCLI's audit records these posts under the group's identity.

### Sending

`POST /v1/threads/:threadKey/messages`, with the send key, takes `{ text, sendId, agentId?, files? }` and nothing
else: a body naming anything more, such as a channel or a thread, is refused with 400, because where a reply posts is
the host's to decide from the thread. The text is at most 4,000 characters, not blank unless the reply carries a file,
and the `sendId` is 16 to 64 letters, digits, `_` or `-` that the app keeps for one draft. The body may be 32 KB.

The thread passes the history check afresh: a call in it would be accepted right now, asked of the platform and never of
the list's cache, or it is the person's own DM, by the proof the list uses. A Slack DM thread takes a reply like a
channel thread: it posts into that DM as the person, which is what they could type there themselves. It must be a Slack
thread, not a channel's top level, in the person's own workspace. The host picks the token from the device's own person
and posts the text unchanged with `chat.postMessage`, in that thread, through the gateway as the agent holding that
token, once, through the same transport post-as-owner uses. It adds nothing to the words.

The app's server never answers 502 or 504: Cloudflare, in front of it, replaces an origin's 502 or 504 with its own
error page, so the phone would see a bare status instead of the sentence. `send` and `json` in
`src/modules/voice-call/http.ts` make a literal 502 or 504 a type error; failures that are worth trying again answer
503.

The answer is `{ outcome: 'sent' }`, `{ outcome: 'failed', error, offerConnect?, reconnect? }` when Slack refused it and
nothing was posted, or `{ outcome: 'unknown', error }` when Slack did not answer
and it may have posted. `offerConnect` says connecting Slack again would let it through, and the phone keeps its send
key, which still works: the app offers Connect Slack beside the reply box. `reconnect` comes only with it, where Slack no
longer takes a connected token, for builds before `offerConnect`, which read it as the key being gone and forget it. Only
a 401, or a key the phone no longer holds, takes the key in the app. An unknown is never retried. A request whose `sendId` posted, or may have, gets that answer back
and never posts again, an unknown with a sentence saying it was already tried and that changed words send anew, and one
that arrives while the first is still sending is answered as unknown. That record lives in host memory for at least an
hour, so a host restart ends it, and so can a later reply once the hour has passed. A failure posted nothing, so it is not kept and the same `sendId` may try
again. The app keeps one `sendId` while the words stay the same, so tapping Send again after an unknown posts at most
once within that bound. It waits two minutes for an answer, past the host's 30-second gateway wait and 60-second Slack
call; a slow visibility check before those can still outlast it, which reads as unknown. It shows each outcome as it is,
keeps the words after anything but a send, and asks the person to check the thread after an unknown. Refusals before
posting answer as other routes do: 404 for a thread the person cannot use, 409 for one the app cannot reply in, 401 for
a key that is not a send key.

A device gets ten replies a minute and 300 a day, and past that a 429. Only a reply about to post counts. The counts
live in host memory, so a host restart forgets them.

From there Slack delivers the post like any message from that person. Slack stamps `bot_id` on a user-token post, and
the Slack adapter turns a registered workspace human back into a human before any filter or the router sees it, so
routing, the archive and approvals treat it as typed. A plain `@name` in the text is not a mention: Slack's `link_names`
no longer links users. A reply in a thread where the agent is already engaged reaches it; elsewhere it needs `<@U…>`.

The send-once record, the outcomes, the claim and the limits above are one shared core, `src/modules/mobile/reply.ts`;
each platform supplies only where a reply can go and how it posts.

## Replying in Discord

A person replies in a Discord thread from the app, and the bot of the agent the thread has been talking to posts it
under a line naming them. The host hands the same words to that agent as the person's own message, so the agent, its
gates and its approvals treat them as typed. Words and [files](#photos-and-files), only in a thread: not a channel's top
level and not a DM.
It reads `src/modules/mobile/discord-send.ts`.

### Turning on replies

A Discord pairing, or a Slack pairing in a workspace with no send app, has no sign-in to connect, so a device gets its
send key by a link instead.

1. The app asks `POST /v1/replies/enable` with its read key. The host refuses unless the pairing's person is a Discord
   user, or a Slack user of a workspace with no send app, then issues a claim, 256 random bits kept by hash in memory for ten minutes and bound to that device, and DMs
   the person `https://app.<suffix>/replies#<claim>`. That DM is how the person shows the device is theirs; it never
   reaches an agent. A device gets three a minute and 20 a day, counted with Connect Slack.
2. The person opens the link on the phone that asked. The page builds `anderton://replies-enabled?claim=…&host=…` from
   the fragment, which never reaches the host, and spends nothing, so a link preview costs nothing.
3. The app redeems the claim at `POST /v1/slack/claim`, the same route and the same one-time, device-bound claim Slack's
   sign-in uses. The answer is the send key. A read key alone never yields one.

A device is one pairing, so a person paired as both a Slack and a Discord user sets up each pairing on its own.

While the claim is out, which can take the host's whole 25-second wait, the thread shows "Finishing Slack connection…"
("Turning on replies…" for a reply link). When a claim turns into a send key, by either route, the app says so once: a
toast over whatever screen is up, held for three seconds and faded out (`mobile/src/toast.ts`). It does not come back
on a later thread. A claim the host refused shows the host's own sentence, such as the 503's "Still finishing. Tap Open
Anderton again in a moment.", and one that never reached the host says so. With several accounts on one host, only the
asking account hears how its store went (503, 502), so that answer wins; the 410 every other account gets gives way to
any other answer. A link for a host the phone has no account on, or a key the phone could not keep, shows the app's own
note. Each stays as a banner on the thread until the person acts on it.

### Sending

The same route and the same checks as Slack: the send key, `{ text, sendId }`, the history check asked afresh, and the
send-once record. Then:

1. **Who it goes to.** Among the thread's agents the person can call right now, the one whose bot posted there last,
   by the archive, else the one engaged last. A thread no agent has posted in or engaged has no reply box. The app shows
   that agent as `replyTo`; the screen's answer may be a minute old, and a send always asks again.
2. **Whether they could post there themselves.** The host reads, as that agent's bot, the person's own permissions in
   the thread (`discordPoster`, `src/modules/voice-call/group/place.ts`): they must see it, be allowed to send messages
   in threads, be in it if it is private, be able to manage threads if it is locked, and not be timed out. A bot
   posting for someone never reaches further than they could. A check that fails refuses.
3. **What it posts.** `**<name>** · from the Anderton app`, then the words as a block quote (`>>> `), so no line of
   theirs can stand where the name line does. The name is the server's own: the person's nickname there, else their
   display name, else their username, never one the app sends. Every mention in the name and the words is broken with
   a zero-width space, and the post sets `allowed_mentions: { parse: [] }`, so it pings no one, `@everyone` included.
   Words that carry the name line's phrase are refused, even split up by markup or format characters; the quote, not
   that check, is what keeps a line of theirs from standing where the name line does. One Discord message holds 2,000
   characters, name line included.
4. **How it posts.** Once, as the bot, with a random `nonce` and `enforce_nonce`, so Discord itself turns a repeat of
   that request within a few minutes into the first message. No answer, or a server error, is `unknown`, as in Slack.
5. **Telling the agent.** After Discord answers with the message id, the host routes the words through the router as a
   message from the person: the id a message they typed there would carry, `isBot` false, addressed to that agent so it
   wakes. The archive keeps it once, as theirs, and the app shows it that way. Nothing is routed for an `unknown`, and
   a posted reply the router could not take answers `sent` with a warning that the agent was not told.

The post itself does not reach an agent as a message. The posting bot's own adapter drops its own message, and every
sibling bot receives it as a bot's message, live or when it catches up after a gap. Before posting, the host records
the post in `discord_relay_posts` (`src/discord-relay-posts.ts`): the bot, the thread, the nonce and a hash of the text,
never the text, then the message id once Discord answers. The Discord inbound filter drops a sibling's copy that
matches, by nonce or text until the id is known and by id after, and the record lasts a week, across restarts. A
refusal deletes it; an `unknown` keeps it. Each bot loads the record before it connects; a load that fails logs, leaves
Discord running, and is tried again by the next bot to start. Until one succeeds, a sibling's copy of a post made
before the restart routes as that bot's message, never as the person's. The thread history an agent is shown when it first
engages a thread is read from Discord, not routed, so there the post appears as its bot's, under the name line.

The link that turns replying on is a one-time value like a pairing code, so a replayed thread history drops it the same
way (`buildThreadContextBlock`, `src/thread-context.ts`).

## Photos and files

The open composer has a **+** where the thread takes files. It opens the system's photo picker or its file picker, so
the app reads only what the person picks and needs no access to the library (`mobile/src/pickers.ts`). Photos are
re-encoded as JPEG at 0.7 quality, and iOS hands over JPEG rather than HEIC; a screenshot stays a PNG. Android's
picker reports the original's type and name for a re-encoded photo, so the app names and types it by the bytes written.
The picked file shows as a thumbnail, or by name, with a remove button. A reply carries one file of at most 25 MB, of
the kinds the host takes: JPEG, PNG, GIF, WebP and HEIC images, PDF, plain text, CSV, Markdown, and Word, Excel and
PowerPoint documents (`.docx`, `.xlsx`, `.pptx`). The app refuses anything else, or anything over the cap, when it is
picked.

**Upload, then reply.** On each attempt the app sends the file to `POST /v1/uploads` with the send key: the raw bytes,
with its name, percent-encoded, as `X-File-Name`. The host (`src/modules/mobile/uploads.ts`):

- reads the kind from the bytes and never from the type the phone declares: an image, a PDF, a zip only when its
  directory names a Word, Excel or PowerPoint document, and text only when it is all UTF-8 with no control characters
  but tab, newline and carriage return, CSV or Markdown by its name and plain otherwise. Anything else is refused with
  415. The name keeps the person's words and takes the extension of the kind the bytes are;
- streams it to its own file, mode 600, in a directory of this process's own under the system temp directory, and stops
  reading at 25 MB, declared or not, with 413;
- keeps nothing of a refused, cut-off or empty upload;
- holds a file ten minutes, for the device that sent it only, and at most three a device, counting uploads still
  arriving. Each upload counts against the device's reply limit, ten a minute and 300 a day, with the replies. A host
  that stopped mid-upload leaves its directory, which the next host removes once it is ten minutes old.

The reply then names the file: `files: [uploadId]`, one at most. The route takes it from the hold before it posts,
refusing the reply with 410 if it is gone or another device's, and deletes it once the reply has been tried, whatever
the outcome. A retry uploads afresh under the same `sendId`, so the send-once record still answers it: a reply that
posted, or may have, never posts again, and the retry's file is deleted unused. Uploads reach nothing but this route,
and the files methods nothing but the reply route's own targets (`src/modules/mobile/attachment-reach.test.ts`), so
nothing an agent starts sends a file this way. A thread's answer says `files: true` where a reply there may carry one;
an older app ignores it, and an older host never says it, so the app shows no **+**.

**Discord.** A file goes only where the person could attach one themselves: the posting check reads their own Attach
Files permission there, live on each send, and without it the thread offers no **+** and a file is refused. The bot
posts the file with the name line in one message, as Discord's `multipart/form-data` (the body in
`payload_json`, the file as `files[0]`, typed by its bytes), with the same `nonce`, `allowed_mentions` and relay record.
A file alone posts under the name line with no quote. Discord takes files up to 20 MB on any server, so a larger one is
refused before anything is spent. The file is read for the agent before anything is posted, and handed to it as a
typed message's attachment, bytes inline, within the same per-file and per-message budget the bridge keeps for an
attachment someone posts there (`chat-sdk-bridge.ts`).

**Slack.** The words go as the file's comment, in one message, as the person, into the channel and thread the host
verified for this reply. The file is reserved with `files.getUploadURLExternal` through the gateway; its bytes go
straight from the host to the upload URL Slack answers, with no gateway and no identity header, and only when that URL
is `https` on `files.slack.com` with no port or credentials of its own; `files.completeUploadExternal` then shares it.
An upload never completed is discarded by Slack, so a failure before that step posted nothing. Slack does not say the
message's `ts`, so the person's copy of it in the archive dates the reply for the app: their one message since the host
asked for the share (less a second for the clocks) whose letters and digits are the comment's, waited for up to ten
seconds and still the only one a moment and a half later. Any other answer leaves the reply undated, and a lookup that
fails does too, since the file has posted. A file with no words is never archived, so the host's own time places it.

- **A workspace with no send app** sends files when the group's token holds `files:write`, read from Slack's
  `x-oauth-scopes` header on the send's own `auth.test`; a token without it is refused before anything posts.
- **The send app's workspace** sends them under the person's own token ([Connecting](#connecting)). A token
  connected before `files:write` was asked for lacks the scope and sits on the `chat.postMessage` path alone, and one
  granted `chat:write` alone lacks the scope: the reservation's own answer says so (`not_authed`, `missing_scope`, or
  `x-oauth-scopes` without `files:write`), nothing is sent, and the reply is refused, "Reconnect Slack to send files",
  with `offerConnect`, so the app offers Connect Slack and the phone keeps sending words.

**History.** The archive keeps a message's words only, and a message with no words not at all, so thread history shows
no attachments, from the app or anyone else. On the phone that sent it, a reply's thumbnail stays on the thread's copy
of it until the app closes, and a reply of a file alone stays where the thread dates it.

## Thread list screen

Everything the person acts on sits in a bar at the bottom of the list, above the safe-area inset: the scope button,
search, and New call. The scope button names the workgroup, when there are several, and the channel. The top of the
screen holds only that context, the counts and Accounts. When the keyboard opens, the bar sits on top of it. Neither
platform resizes the app for the keyboard, because Android draws edge to edge, so the bar is padded by hand. React
Native measures an Android keyboard from the top of the navigation bar and an iOS keyboard from the bottom of the
screen, so `keyboardTop` in `mobile/src/keyboard.ts` adds the navigation bar back on Android only.

The scope button opens a sheet over the list. It holds the workgroups when there are several, as one row of chips that
scrolls sideways (`mobile/src/chips.tsx`), with the chosen one scrolled into view when the sheet opens; then a Find a
channel filter, and the chosen workgroup's channels as one vertical list: All channels first, then the most recently
active. Choosing a channel closes the sheet, and so does dragging its top down, tapping outside it or pressing Back.
Recency comes from the thread rows the list has shown since the app started, matched by each row's `channelKey`, and no
request is made for it. A list filtered to one channel shows only that channel's rows, so a channel no list has shown
yet sorts after the active ones, in name order. The sheet is drawn in the screen's own window rather than a React Native
`Modal`: on Android a Modal is a separate window that sends no keyboard events, so its channel filter could not lift the
sheet above the keyboard.

## Why this is safe beside previews

Previews are agent-written pages on sibling subdomains of the same suffix. The API sets no cookies and sends no CORS
headers, so such a page cannot read a response, and it has no way to obtain the bearer key. Bearer requests need a
preflight, which the API answers 404. Pairing codes and keys are never logged: a malformed `POST /v1/pair` is not
logged at all, because a JSON parse error quotes its input.

## iPhone

The iPhone build goes to internal TestFlight only, not the App Store. Testers are App Store Connect users with access to
the app, and nothing here creates a public listing. Expo builds the IPA in its cloud and holds the signing credentials
in our organization there. The host uploads the IPA to Apple. No App Store Connect key goes to Expo, because a
team key reaches every app on the Apple team and an individual key cannot manage certificates or profiles anyway, so
`eas submit` is not part of this route.

### Build

Build from a `git archive` copy of one commit, never from a worktree, so that only `mobile/` is uploaded:

```bash
git archive <commit> mobile | tar -x -C <scratch dir>
cd <scratch dir>/mobile
export EAS_NO_VCS=1 EAS_PROJECT_ROOT="$PWD" EXPO_TOKEN=vault
onecli run --agent host-app-builds -- npx -y eas-cli@27.2.0 build:inspect --platform ios --profile store --stage archive --output <inspect dir>
onecli run --agent host-app-builds -- npx -y eas-cli@27.2.0 build --platform ios --profile store --non-interactive --freeze-credentials
```

Read the file list from `build:inspect` before the build. `--stage archive` packs the upload and touches no credentials.

Build numbers live on EAS (`appVersionSource: "remote"`), and both profiles set `autoIncrement`, so every build takes the
next iOS build number and Android `versionCode` with no commit. Raise `version` in `mobile/app.json` when you want a new
TestFlight version group. The iOS counter was seeded at build 2 on 2026-11-02, the last manual value, so the first
remote build is 3. Without that record EAS reads the local build number, which defaults to 1 when `ios.buildNumber` is
absent, so it would build 1 and then 2, both already on TestFlight and refused by Apple. Android needed no seed:
every APK before this was `versionCode` 1, and the counter only rises.

### Upload

```bash
pnpm exec tsx scripts/mobile-ios-upload.ts <build.ipa> --build <appBuildVersion>
```

`appBuildVersion` is on the build record: `eas build:view <build id> --json`, or the build's page on expo.dev.

The script calls Apple's Build Uploads API: it creates a `buildUploads` record, reserves a `buildUploadFiles` record,
sends the parts to the pre-signed URLs Apple returns, commits the file, then polls until the build is `VALID`. `--build` is
required: pass the build record's `appBuildVersion`, because EAS assigns it. The version comes from `mobile/app.json`,
or from `--version`. It prints states and never a
token or an upload URL.

A record with no file is safe to delete. Creating one with this key answered 201 in `AWAITING_UPLOAD`, deleting it
answered 204, and no build or TestFlight version appeared, so the script deletes its record if a part fails. Apple's
only documented email is the one when processing finishes. Once a file is committed, a failure stays on the record as
`FAILED` with Apple's reasons, and the retry uses the next build number. A build reaches testers only through a TestFlight group, so an upload on its own reaches
nobody unless a group has automatic distribution on.

### The upload key

`~/.appstoreconnect/private_keys/ApiKey_<keyId>.p8` is the accepted exception to keeping secrets in OneCLI: the host
signs a short-lived ES256 token with the key, and a gateway that only injects headers cannot do that. The file is mode
0600 and must never be printed, copied, logged or passed on a command line. It is an individual key belonging to a
dedicated App Store Connect user with the Developer role and access to this one app. Its token uses `sub: "user"` and no
issuer. The key can create build uploads and read the team's user list, and has no Provisioning, Sales or Finance access.

To rotate it, an Admin revokes it under Users and Access, Keys, Individual Keys, or the dedicated user revokes it from
their profile. That user then generates a new key from their profile under Individual API Key, and downloads it, which
Apple allows only once. Put it in the same folder at 0600 and delete the old file. The script takes its key id from the
file name and refuses a folder holding more than one key. Revoke at once if the file may have leaked: nothing reinstates
a revoked key, and the next upload only needs the new one.

### Signing

The Apple Distribution certificate and the App Store Connect profile for `ai.anderton.app` are made by hand in the
Apple Developer portal from a CSR, then stored in Expo, because making them through Expo would need an App Store Connect
key or an Apple login. Expo holds the signing key and signs every build with it. The host keeps only what is not secret
in `~/.config/anderton-app/`, mode 0700, out of the repo:

| File                             | What it is                     |
| -------------------------------- | ------------------------------ |
| `ios-dist.certSigningRequest`    | The CSR given to Apple.        |
| `ios-dist.cer`                   | The certificate Apple issues.  |
| `anderton-store.mobileprovision` | The App Store Connect profile. |

`ios-dist.key`, `ios-dist.p12` and `ios-dist.pass` were needed only to store the certificate in Expo. They stay there at
0600 until the owner deletes them by hand: the guard refuses an agent's `rm` on that path, and `trash` would leave the
key recoverable, which is not removal. A renewal makes new ones, so nothing needs the old files.

Build the p12 with `openssl pkcs12 -export -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -passout
file:ios-dist.pass`. eas-cli parses OpenSSL's default form too, but the macOS keychain on the build machine has a
history of refusing it.

`eas credentials` cannot store them from a script: it has no flags and throws without a TTY, because every step is a
prompt. Run the same steps as GraphQL mutations against `https://api.expo.dev/graphql`, under `onecli run --agent
host-app-builds`, in the order eas-cli uses: `createAppleTeam`, `createAppleDistributionCertificate`,
`createAppleAppIdentifier`, `createAppleProvisioningProfile`, `createIosAppCredentials`, and
`createIosAppBuildCredentials` with `iosDistributionType: APP_STORE`. None of them talks to Apple.

With credentials stored, `eas build --non-interactive --freeze-credentials` skips Apple entirely: it checks locally that
the profile names this certificate and bundle id and has not expired. If Expo ever stops signing with them, make a new
p12, set `credentialsSource: local` under `build.store.ios` in `mobile/eas.json`, and write a `credentials.json` into
the build copy pointing at it and at `~/.config/anderton-app/anderton-store.mobileprovision`. Never commit it.

### Expiry

- A TestFlight build stops working for testers 90 days after upload, so upload a new one before that.
- The certificate and profile expire too, on the dates the portal shows, about a year out. Renewing means a new key and
  CSR, a new certificate and profile, storing them in Expo again, and deleting the new key, p12 and password from the
  host.

### Encryption

`ITSAppUsesNonExemptEncryption` is `false`, which Apple defines as using no encryption or only forms exempt from export
documentation. HTTPS here goes through the operating system. WebRTC encrypts media itself with standard DTLS-SRTP, and
for an industry-standard algorithm outside the operating system Apple asks only for a declaration to the French
government, and only when the app is sold in France. The app uses no proprietary algorithm and does not turn on
LiveKit's end-to-end encryption. Recheck this before any public TestFlight link or App Store release: the value is a
declaration to Apple and LiveKit's WebRTC ships its own crypto, selling in France changes the answer, and Apple notes
that some exempt apps owe a year-end self-classification report.
