# Channel Isolation Model

NanoClaw decouples messaging channels from agent groups. When you connect a channel (Discord, Telegram, Slack, GitHub, etc.), you decide how it relates to your existing agents. There are three session-isolation levels.

Memory has a separate, explicit boundary: the workgroup. Every agent group in
one workgroup reads and edits the same canonical Markdown tree at
`data/workgroups/<workgroup-id>/memory`. An agent group's `standing-instructions.md`
(composed into `CLAUDE.md`/`AGENTS.md`) holds provider, identity, and standing
instructions; it is not a memory store. Use different workgroups whenever memory
or archived conversation must not cross between agents.

Agent credentials are not an isolation boundary, and were never a reliable one.
Every container carries all three provider credentials whatever its own
provider, so an agent can drive `codex exec` or `opencode` headless with the
fleet's own accounts, and `claude -p` from any shell the Claude Code CLI did not
start. The Claude CLI deletes `CLAUDE_CODE_OAUTH_TOKEN` (not an
`ANTHROPIC_API_KEY`) from every child it spawns, so in a Claude-provider session
signed in with an OAuth token a plain `claude -p` run from the Bash tool fails
with "Not logged in". Only the tool-less review form reaches the runner's
credentials there ([agent-runner-details.md](agent-runner-details.md)); the token
is still in the container, which is why this is no boundary either. The credentials:

- the **Claude** ring, as env;
- the **Codex** `auth.json` from `~/.codex-<folder>` where a group has its own
  home, otherwise `~/.codex`, plus any `codexAuthFallbacks` homes;
- **OpenCode**: no credential at all. OpenCode sends a placeholder key and the
  OneCLI gateway injects the vault secret on `opencode.ai`, so no `auth.json`
  is staged and each spawn removes one left in the session tree. The agent can
  use the key through the proxy but cannot read it.

What crosses is the CREDENTIAL, not the host home. Every Codex home is staged
per session: the container's `/home/node/.codex` (and each
`/home/node/.codex-fallback-N`) is a session-owned directory with a generated
`config.toml`, into which the host home's `auth.json` is bind-mounted as a
single file so token refresh still writes back. No container can write the
operator's `config.toml`, `hooks.json`, `hooks/` or `AGENTS.md`, so none can
plant a hook a host-side `codex` run would execute. OpenCode's default-model
config is staged into a session-private XDG tree.

No codex home carries the destructive-action guard chain either. The image
installs it root-owned at `/etc/codex/hooks.json`, beside a `requirements.toml`
that pins `[features] hooks = true` (sources: `container/codex-system/`). Codex
reads that system layer under every `CODEX_HOME` and dispatches it as managed,
with no per-home trust row. So `--disable hooks`, `-c features.hooks=false`, an
edited or emptied home `hooks.json`, a user or project `enabled = false`, or a
copied `auth.json` in a fresh home all still run the guard. The hook command
starts bun by absolute path with a fixed `--config` and unsets bun's preload and
inspector variables, and the runner loads guard cores only from their installed
paths (`guard-core-paths.ts`). Each spawn's `hooks/list` check refuses a
provider=codex session, and a peer runtime fails closed, when the system chain
is missing or not dispatchable.

What this does not close: the agent can read every `auth.json`, so it can call
the model API with the token from its own code, outside codex. Codex runs hook
commands as `<login shell> -c` under the caller's environment, so bash startup
variables (`BASH_ENV`, `SHELLOPTS` with `PS4`, exported functions) and
`LD_PRELOAD` still run code before the guard. The env scrub in the hook command
is a list of names, not an allowlist. Closing these needs a credential the agent
cannot read. Plugin hooks (workflow-agents' `codex-guard.sh` among them) stay
in each home's user layer: they are workflow aids, and the agent can remove
them.

One READ path is deliberately wider. A `provider: codex` group also gets its
resolved host Codex home mounted READ-ONLY at `/home/node/.codex-host-primary`,
because `refreshCodexAuthFromHost` re-reads `auth.json` from it when the host
rotates a token mid-session, and a refresh source has to be a directory to see a
file the host REPLACED. So a codex-provider container can read that home,
transcripts included. It cannot write any of it. A fallback identity's
`sessions/` is likewise mounted read-write, but only for `provider: codex`,
where an in-session rotation lands on that home; peer containers get the
credential alone.

What *is* bounded is credential SCOPE, not presence — which account a group
reaches, via the per-group ring and per-group home above — plus the one
withholding lever, `excludePlugins: ["codex"]`, which withholds the Codex
plugin and the credential that rides on it together. A per-group opt-in flag
for Codex host auth (`codexHostAuth`) used to sit in front of the mount; it is
gone, because presence was the wrong thing to gate.

Scope is *available*, not enforced by default. A per-group home exists only
where an operator created one, and on this install almost none do: as of
2026-09-17 no group has a `~/.codex-<folder>`, so all 27 share the one fleet
Codex account; read "bounded by scope" there as a lever to pull per group,
not a control that already holds. OpenCode scope is a vault grant: the spawn
grants exactly one `opencode.ai` secret — the group's own (`container.json`
`onecliSecrets`), else its workgroup's, else `NANOCLAW_OPENCODE_FLEET_SECRET`
(`resolveSpawnSecrets`, `src/onecli-secrets.ts`). This is the one narrowing of
the workgroup-secrets union: a nearer level's OpenCode key replaces the farther
one, because the gateway resolves two matching secrets in no defined order.
A new group needs nothing; a group or workgroup gets its own account by
granting its own secret.

## The Three Levels

### 1. Shared Session

Multiple channels feed into the same conversation. The agent sees all messages from all channels in one thread.

**What's shared:** The agent workspace, agent instructions, workgroup memory, and the conversation itself. A GitHub PR comment and a Slack message appear side by side in the agent's context.

**Example:** A Slack channel paired with GitHub webhooks. The agent receives PR review requests via GitHub and discusses them in Slack — all in one session. When someone comments on a PR, the agent can reference the earlier Slack discussion about that feature.

**When to use:** When one channel feeds context into another. Webhook/notification channels (GitHub, Linear) paired with a chat channel (Slack, Discord) are the classic case.

**Technical:** Both messaging groups are wired to the same agent group with `session_mode: 'agent-shared'`. Session resolution looks up by agent group ID only, ignoring the messaging group — so all channels converge on one session.

---

### 2. Same Agent, Separate Sessions

Multiple channels share the same agent (same workspace, instructions, personality, and workgroup memory) but have independent conversations.

**What's shared:** The agent workspace, instructions, personality, tools, and the workgroup memory canon. If you tell the agent something in one session, it can save that to the canon and recall it in another.

**What's separate:** The conversation thread. Messages from one channel don't appear in the other channel's session. Each channel has its own context window and conversation history.

**Example:** You have three Telegram chats with your agent — one for a side project, one for personal tasks, one for work. All three share the same agent workspace. If you ask it to remember your API key naming convention in the project chat, it may recall that convention in the work chat too. But the conversations themselves are independent.

**When to use:** When you're the primary (or sole) participant across channels and you want a unified agent identity. This is the most common setup for personal use across multiple platforms or multiple groups within one platform.

**Technical:** Multiple messaging groups are wired to the same agent group with `session_mode: 'shared'` (or `'per-thread'`). Each messaging group gets its own session, but they all run in the same agent group folder.

---

### 3. Separate Agent Groups

Each channel gets its own agent group, with its own workspace, instructions,
provider identity, container, routing, and conversation history. Memory and
archive isolation depends on the workgroup assignment.

**What's shared:** Nothing when the agent groups are also in different
workgroups. Deliberate siblings in the same workgroup share its memory canon and
archive while keeping their agent-scoped surfaces separate.

**Example:** You have a Telegram group with a friend and a Discord server for a
team project. The friend should not know what you discuss with your team, and
vice versa. Put the two agent groups in different workgroups. By contrast, a
Claude agent and Codex agent working on the same project can be separate agent
groups in one workgroup and intentionally share memory.

**When to use:** Use separate agent groups for separate identity, provider,
container, or routing. Also use separate workgroups when the information in one
channel must never be available to the other.

**Technical:** Each channel is wired to a different agent group, each with its
own folder under `groups/`. `agent_groups.workgroup_id` determines whether
their canonical memory and archive are shared or isolated.

---

## Bind sources

An agent can plant a symlink in any tree it can write, and Docker follows a symlinked bind source as root. So `buildMounts` ends with one pass over every mount (`pinMountSources`, `src/mount-source-gate.ts`), whichever site added it:

- **Agent-writable trees** are the spawn's writable mounts, plus the group's own and sibling folders and the workgroup tree. A sibling's container writes those even when this spawn does not mount them.
- A source inside those trees must resolve inside them, and is bound by its resolved path, so a later swap of the link moves nothing. Anything else is dropped with a WARN, and the spawn continues.
- A real source swapped for a link after that pass aborts the spawn at the last check before `docker run` (log: `Spawn stage timing` `stage="mount-sources-pinned"`). Only runc's own resolution, a window of milliseconds, stays open.

Two rules sit beside it. A link into a sibling's folder mounts read-only, as does a link into the workgroup tree in memory-only mode, which withholds that tree, and a link never reaches a group folder or a `container.json`. A path bound read-only over a writable parent (`plugins/`, for one) stays read-only by every other route.

## How to Decide

Decide the conversation boundary and memory boundary separately:

- **No information may cross** → Separate agent groups in separate workgroups
- **Yes, and the channels should see each other's messages** → Shared session (level 1)
- **Yes, but the conversations should be independent** → Same agent, separate sessions (level 2)
- **Separate provider identities should share durable knowledge** → Separate sibling agent groups in one workgroup

### Rules of Thumb

| Scenario | Recommended Level |
|----------|------------------|
| Just you, multiple platforms (Telegram + Discord + Slack) | Same agent, separate sessions |
| Just you, multiple groups on one platform (3 Telegram chats) | Same agent, separate sessions |
| Webhook channel + chat channel (GitHub + Slack) | Shared session |
| Channel with friend A and channel with friend B | Separate agent groups and workgroups |
| Personal channel and work channel | Separate agent groups and workgroups |
| Team channel with different access levels | Separate agent groups and workgroups |
| Claude + Codex siblings on one project | Separate agent groups, same workgroup |

### When in Doubt

If the participants are the same across channels → same agent group is usually fine.

If different people are involved → use separate agent groups and separate
workgroups. Agent-group separation alone does not isolate memory between
intentional workgroup siblings.

## Entity Model

```
workgroups (one canonical memory tree and archive)
    ↑ 1:many
agent_groups (workspace, standing-instructions.md, personality)
    ↕ many-to-many
messaging_groups (a specific channel/chat/group on a platform)
    via
messaging_group_agents (session_mode, engage_mode, engage_pattern, sender_scope, ignored_message_policy, priority, threads)
```

Wiring-creation defaults for engage mode/pattern, thread policy, and unknown-sender policy come from the channel adapter's declaration (per DM/group context), overridable per wiring at creation — see [setup-wiring.md](setup-wiring.md#channel-defaults-two-level-model) and [api-details.md](api-details.md#channel-defaults).

- **Shared session:** multiple messaging_groups → same agent_group, `session_mode = 'agent-shared'`
- **Same agent, separate sessions:** multiple messaging_groups → same agent_group, `session_mode = 'shared'`
- **Separate agents:** each messaging_group → different agent_group; choose the
  same or different workgroup explicitly based on whether memory should pool
