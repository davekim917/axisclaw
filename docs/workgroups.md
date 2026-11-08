# Workgroups

A **workgroup** is a tenant-level grouping that contains one or more `agent_groups`. It is the data-pool boundary for:

- **Chat archive** — sibling agents in a workgroup can read each other's archived chat history via the existing `resolve_thread_link` / `search_threads` / `read_thread` MCP tools.
- **Durable memory** — siblings read and edit one canonical Markdown tree and receive workgroup-wide recall before every admissible turn.
- **Access** — OneCLI secrets, `tools` and MCP servers declared on the workgroup are inherited by every member agent_group at container spawn time. This is where access is granted by default; see [Workgroup access](#workgroup-access).

Sibling `agent_groups` (e.g., a Claude twin + a Codex twin, plus future siblings like `<x>-research` or `<x>-data-analyst`) are peers — each remains a separate row in the database with its own platform bot user, CLAUDE.md, container, and routing identity. No sibling is a parent of another; the workgroup is the layer **above** them, not a collapse and not a hierarchy.

---

## Why workgroups exist

NanoClaw's sibling-agent architecture requires per-agent bot identity for native `@`-mentions on Slack and Discord. But the data layer was scoped per `agent_group_id`, so siblings could not see each other's chat history, knowledge graph, or shared credentials.

Before workgroups, this was patched up implicitly via scattered symlinks (`CLAUDE.local.md`, `sources/`, `conversations/`). The pairing was implicit (naming convention `<x>` + `<x>-codex`) and broke silently if any wiring drifted.

The workgroup model formalizes the pairing as a first-class concept with explicit semantics.

---

## Shared memory, background capture, and pre-turn context

The single memory authority for a workgroup is
`data/workgroups/<workgroup-id>/memory`. Containers mount it at
`/workspace/workgroup/memory`; `/workspace/agent/memory` and recognized
provider-native paths are compatibility views of the same files, not
authorities.

Use `write_memory_file` for direct Markdown edits. Its expected SHA-256 check
and atomic replacement prevent a sibling from silently overwriting an edit made
after it last read the file. Treat raw provider-native projections as
read-only. Ordinary same-file raw shell writes retain normal filesystem
last-writer semantics and are an explicit operator escape hatch.

`data/workgroups/<workgroup-id>/memory/generated/memory.md` is a shared
read-only artifact of the removed background curator. Claude, Codex, and
OpenCode all recall from it; there is no provider-specific generated store, and
nothing writes it any more.

Before every admissible turn, the host supplies actual session capabilities,
canonical memory, same-thread evidence, workgroup-wide archive recall, and
exact Slack/Discord permalink provenance. Missing or failed sources produce an
explicit degraded notice; they never broaden the workgroup boundary.

Provider identity, instructions, configuration, continuation state, and all
non-memory customizations remain sibling-scoped. Sharing memory does not merge
bots, sessions, worktrees, routing identity, permissions, or credentials.

---

## Identifier model

Workgroups are identified by a **folder slug** (lowercase letters, digits, hyphens — e.g., `"example-labs"`, `"example-dev"`, `"example-retail"`).

- `workgroups.id` IS the slug.
- `agent_groups.workgroup_id` references it.

For an agent group whose own folder is `<x>` (e.g., `example-labs`), the workgroup id is `<x>`. For a codex twin whose folder is `<x>-codex` (e.g., `example-labs-codex`), the workgroup id is the base slug `<x>` (`example-labs`) — the same workgroup the Claude twin belongs to. They are siblings sharing one workgroup, not parent/child.

A `CHECK` constraint on `workgroups.id` rejects values matching the opaque `agent_groups.id` shape (`ag-<ts>-<rand>`) — this prevents future code from accidentally conflating the two ID namespaces.

## Cross-workgroup read grants

Workgroups remain isolated unless the host operator declares a bounded,
read-only cross-workgroup policy. The grant is workgroup-scoped, so every
provider sibling receives the same access at its next spawn. See
[Cross-workgroup read access](workgroup-read-access.md) for the policy schema,
mounted paths, activation, and rollback.

## Read-only workgroup paths

With the shared filesystem on, the workgroup tree is mounted read-write into
every sibling, so anything the host runs from inside it (a systemd unit's
script, a host-gated task script) is editable by every agent in the
workgroup. Declare such a subpath in `data/workgroup-readonly-paths.json`:

```json
{ "version": 1, "workgroups": { "<workgroup-id>": ["<relative/subpath>"] } }
```

At its next spawn, every container that mounts the path writable gets it
bound read-only on top instead: agents can still read and run it, and only a
host session can change it. Each directory between the writable mount and
the declared path is also bound onto itself, because a plain nested bind can
be defeated by renaming its parent directory away from inside the container.
A declared path that does not exist is skipped, so create it on the host
before declaring it: until a container spawns with the bind, that container
can write there. A declared path that cannot be resolved to itself (a
permission error, a symlink loop, or a symlink on the way) does not fail the
spawn: that workgroup's writable mounts are mounted read-only instead, with an
error in the log, and other workgroups are unaffected. A malformed file aborts
the spawn. The bind protects names, not inodes: a hard link or an outward
symlink under the path, made while it was still writable, is logged at error
level on every spawn and must be removed by an operator. Removing an entry and respawning restores write access. See
`src/workgroup-readonly-paths.ts`.

## Workgroup wiki

A workgroup can keep a domain wiki for its agents to read. When the host has a
checkout at `data/wikis/<workgroup-id>/`, every agent sibling in that
workgroup, whatever its provider, gets it mounted read-only at
`/workspace/wiki` at its next spawn. The composed `CLAUDE.md` / `AGENTS.md`
gains a short section: before asking a human a domain or product question,
read `index.md` and grep the pages; name the page relied on; flag a gap when
asking. See `src/workgroup-wiki.ts`.

No directory means no mount and no section. Trunk never creates, clones, or
refreshes the checkout; keeping it current (an hourly `git pull`, say) is
install config. A symlink or a non-directory at that path is refused, not
followed.

Every sibling can read the whole checkout, `.git/config` included, so keep
credentials out of it: no token in the remote URL and no `http.extraheader`.
Authenticate the refresh through the host's git credential helper.

## Workgroup-scoped plugins

`~/plugins` is fleet-wide: every agent group mounts every plugin unless its
`container.json` `excludePlugins` names it. A whole entry (`"bootstrap"`)
drops the mount (on OpenCode, whose skills come from the host mirror rather
than that mount, it drops the mount and the ruleset and keeps the skills — see
[skills-model.md](skills-model.md)). A sub-plugin path
(`"bootstrap/plugins/wwbd"`, or `"<repo>/<sub>"` for a repo that puts
its sub-plugins at the root) leaves the repo mounted whole — the files stay
readable — and withholds that sub-plugin's REGISTRATION instead: the Claude SDK
plugin list and its hooks, the Codex registration plan and its hook trust, the
`~/.agents/skills` mirror, the OpenCode session XDG skill copy, and the
standing directive in the composed prompt. Each is decided in the namespace
where the path resolves, through one shared predicate.
For a plugin that carries one
tenant's content, that default is backwards, because a group created later
receives it until someone remembers to exclude it. The host-owned policy
`data/plugin-scopes.json` makes such a plugin opt-in:

```json
{ "version": 1, "plugins": { "<plugin directory name>": ["<workgroup-id>"] } }
```

A plugin named there reaches only agent groups in the listed workgroups, on
every path plugin content takes:
- the mount (Claude, and Codex, which registers plugins from it);
- the always-on ruleset composed for Codex and OpenCode;
- the Codex and OpenCode subagent mirrors and the OpenCode skill mirror, which
  never copy a scoped plugin's agents or skills, because their targets aren't
  keyed by workgroup. A copy made before scoping is pruned the next time that
  mirror runs. The subagent mirrors run when a plugin pull brings changes, when
  the codex-sync watcher sees a watched file change, and when it restarts. The
  skill mirror runs at the next enable. To prune at once, run
  `pnpm exec tsx scripts/sync-codex-subagents.ts` and
  `pnpm exec tsx scripts/sync-opencode-subagents.ts`;
- the capabilities snapshot, which names a scoped plugin only inside its
  workgroups.

Plugins the policy doesn't name keep the fleet-wide default, and
`excludePlugins` still applies. No file means nothing is scoped. A file that
doesn't parse stops every spawn on the host until it's fixed (queued messages
wait and the sweep retries), the same rule as
`data/workgroup-read-access.json`. A scoped name that matches no `~/plugins`
directory enforces nothing, and the host logs a warning once per process. The
policy sits outside the plugin clone, so re-cloning a plugin can't drop its
scope. See `src/plugin-scopes.ts`.

The codex-sync watcher (`nanoclaw-codex-sync`) runs as its own long-lived
process. After deploying a change to these paths, restart it with
`sudo systemctl restart nanoclaw-codex-sync`, or it keeps mirroring with the
code it started with.

---

## Declaration model

- **Operator-facing source of truth:** `container.json.workgroup_id` (optional field).
- **Runtime canonical:** `agent_groups.workgroup_id` (DB column).
- **Reconciliation:** the host re-reads `container.json` on every container spawn and reconciles the DB column atomically. An explicit `container.json.workgroup_id` replaces the current DB assignment.

Omitting `container.json.workgroup_id` preserves an existing non-null DB
assignment, including sibling pairings created by migration 036. Only a group
with neither an explicit config value nor an existing DB assignment defaults to
its own folder slug as a workgroup-of-1. To intentionally unpair an existing
member, set `container.json.workgroup_id` explicitly to that member's own folder
slug and restart its containers; removing the field does not unpair it.

### Auto-pairing (migration 036)

The migration backfills `workgroup_id` for existing agent_groups via a suffix-strip heuristic:

- For each row whose `folder` ends with `-codex`: strip the `-codex` suffix; if a sibling row exists with that base folder, set both rows' `workgroup_id` to the base folder (paired).
- Orphan codex twins (no matching base-slug sibling) get `workgroup_id = own folder` and are flagged in the backfill report under `suffix_strip_unmatched`.
- All other rows get `workgroup_id = own folder` (standalone).

The backfill report is written to `logs/migration-036.log` for operator inspection.

Future siblings beyond the `<x>-codex` convention (e.g., `<x>-research`, `<x>-data-analyst`) must declare `workgroup_id: "<x>"` explicitly in their `container.json` — the auto-pairing heuristic only handles the codex-twin shape.

---

## What pools vs what stays agent-scoped

The per-agent projection (built by the host at every container spawn) widens **only** the chat archive table. All other central-DB tables stay agent-scoped:

| Table                      | Pool to workgroup?                                                                               | Why                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `messages_archive`         | **Yes** — workgroup-wide projection                                                              | Siblings share chat history (Requirement R2)                             |
| `backlog_items`            | No (agent-scoped)                                                                                | Each agent has its own todo list                                         |
| `ship_log`                 | No (agent-scoped)                                                                                | Each agent's commits are its own activity                                |
| `tasks`                    | No (filtered by `parent_agent_group_id` — schema column name; refers to the orchestrating agent) | Dispatch ownership is per-agent                                          |
| `agent_group_capabilities` | No (agent-scoped)                                                                                | Orchestrator role is per-agent — pooling would silently widen capability |

The structural test at `tests/structural/projection-chokepoint.test.ts` enforces this invariant: any future MCP tool query against `messages_archive` must go through the projection's chokepoint, and the agent-scoped tables retain their in-container `WHERE agent_group_id = ?` filters.

### Attention sources pool too — and so do the items they produce

`workgroups.attention_sources` (migration 057) is declared on the **workgroup** row, and the files it points at live under `groups/<workgroup>/<root>`. Both sides of that are workgroup data by the same rule as the shared files around them, so the items read out of it pool as well.

| Table / source                 | Pool to workgroup?                       | Why                                                             |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| `workgroups.attention_sources` | **Yes** — the column is on the workgroup | The declared root is a directory in the shared workgroup folder |

The consequence is worth stating outright, because it is coarser than every other row on the Observatory's thread endpoint: **a caller entitled to any ONE agent group in a workgroup sees every attention item that workgroup declares.** An attention item is ownerless by construction — that is what makes it an attention item — so it carries no `agent_group_id` to filter on, and there is nothing finer to gate against without inventing an owner.

The reader that enforces the other half of this boundary is `readReleaseBoardSource` (`src/dashboard/api/board-attention.ts`): the declared `root` is resolved through symlinks and checked to still be inside `groups/<workgroup>/` before anything is read, because that directory is bind-mounted read-write into the workgroup's own containers. Pooling **within** a workgroup is the design; reading **across** two of them is not.

---

## Pooled archive dedup

When sibling agents are wired to the same chat channel, each agent's adapter writes its own copy of every inbound user message into the archive. The workgroup-widened projection deduplicates them via `GROUP BY (messaging_group_id, thread_id, role, sender_id, sent_at, text)`:

- User messages (same `sender_id` = originating user) collapse to one row.
- Assistant messages (`sender_id = agent_group_id`, distinct per sibling) survive as separate rows.

`MIN(id)` picks the surviving row deterministically (stabilizes the FTS index across spawns).

A projection extended in place rather than rebuilt (`appendArchiveProjection`, #360) reproduces this exactly. A sibling's duplicate arriving in a later batch is merged into the row already projected, not discarded: `id` and `created_at` take the lower value, `channel_type`, `channel_name`, `platform_id` and `sender_name` the higher, so the result matches a full build including ids. The merge uses NULL-safe comparisons, because SQLite's two-argument scalar `min()`/`max()` return NULL if either argument is NULL while the aggregates used by the full build skip NULLs.

---

## Canonical repositories and topic worktrees

Each `(workgroup, repository)` has one host-owned normal clone at
`data/repositories/<workgroup>/<repo>`. Its working tree is never mounted into
agent containers; host tooling reads that clean tree directly.

Each conversation topic keeps its checkouts under
`data/v2-topics/<workgroup>/<work-unit>/worktrees/`, mounted at
`/workspace/worktrees/`. `<repo>` is the thread's primary checkout. In `clone`
mode, `<repo>@<slug>` holds any other branch the thread asks for
(`create_worktree` with `branch`), so threads never contend for one shared
checkout; in `worktree` mode a thread keeps one checkout per repository, and a
request for another branch is refused. Sibling
agents in the same topic resolve the same work-unit and checkouts. Different
topics have distinct paths, branches, indexes, and Git admin directories.
Existing checkouts are never automatically rebased, branch-switched, or reset,
and a checkout no longer on the branch it was created for is refused, not
reused.

`NANOCLAW_CHECKOUT_MODE` decides how a NEW checkout is made. `worktree` (the
default) makes a standard linked worktree of the canonical, as before. `clone`
has the host build an independent clone (`repository_checkout`): it hardlinks
the canonical's objects, is built in a staging dir beside `worktrees/` that no
container mounts, and appears with one rename only once fully initialized.
With `NANOCLAW_DEPENDENCY_CACHE=apply`, each package dir whose lockfile has a
verified cache entry holding every package npm would install on this platform
gets a shared read-only `node_modules` farm; any other gets none, and `npm ci`
makes a private copy. `clone` needs containers that run as the host uid and is
refused, with a WARN when first
used, otherwise. Resolution is shape-aware in
both modes, so switching back to `worktree` strands no clone. Worktree cleanup
collects an idle clone only after proving that the commits of every local ref,
HEAD and the stash are already on `origin`. A tag the host recorded when it
built the clone, still at the same object, is the canonical's, not the
clone's own work, so it does not count.

Containers fetch with their scoped OneCLI identity. The host never performs a
credentialed Git network operation: it publishes validated local clones and
advances a clean canonical only from refs already fetched into its mounted Git
metadata. One stable host lock inode serializes create/fetch, refresh, transfer,
cleanup, and maintenance. Origin pins and transfer tombstones live in
`data/repository-state/<workgroup>/<repo>` and are not agent-writable.

`repository_publish`, `repository_transfer` and `repository_refresh` are handled
off the serial outbound-delivery drain (`src/modules/repository-workspaces/job-runner.ts`):
the delivery loop acks the row and one global FIFO chain runs the action, so no
other session's messages queue behind a publication. That is what lets the mount
quiescence wait `NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS` (default 600000, ten
minutes) for sibling containers to reach a safe point before it kills them;
every other `quiesceSessionsForRepositoryMounts` caller keeps the 120s default.
Each action gets one attempt per host process — a retry would re-fence and
re-kill every sibling — and a host that dies mid-action replays it on the next
start, because the undelivered `messages_out` row is the durable record.

`scripts/migrate-repo-store.ts` inventories legacy clones, mirrors, and collided
worktrees read-only by default. `--execute --quiesced` is accepted only with a
stopped service, zero install containers, no repository writers, and a passing
allocated-byte capacity gate. It keeps hash-bound manifests, synthetic rescue
refs, external bundles, and the complete old topology in host-only migration
storage through audit and rollback retention.

---

## Per-agent Git identity

An agent group may declare its Git author and committer identity in that
agent's `groups/<agent-folder>/container.json`:

```json
{
  "gitIdentity": {
    "name": "Example Build Agent",
    "email": "example-build-agent@example.invalid"
  }
}
```

`name` and `email` are an all-or-nothing pair. The host supplies both author
and committer variables on that agent's next spawn, so ordinary Git commands
and the built-in `git_commit` MCP tool record the same identity. Omit the field
to preserve the existing `credentialFolder`-scoped Git variables, including
their behavior through the built-in MCP tool.

This is agent-scoped rather than workgroup-scoped. To enable it only for one
workgroup, add the field only to the intended agents' files; every other
workgroup keeps its current identity behavior. Git signing is separate and is
not configured by this field.

The host snapshots runner source at boot, and a container receives its Git
environment at spawn. After adding support or changing this field, restart the
host to refresh the runner snapshot, then recycle the affected containers or
allow fresh spawns; a host restart can preserve running containers.

---

## Workgroup access

Access is granted to the workgroup, not to one member: every sibling gets what the workgroup declares at its next
spawn, and is withheld what the workgroup opts out of. Each kind lives on the `workgroups` row and is resolved at spawn
by one function that the capability snapshot also uses, so what an agent is told matches what it gets:

| Access                                   | Column           | Resolved by                                                    |
| ---------------------------------------- | ---------------- | -------------------------------------------------------------- |
| OneCLI secret grants                     | `onecli_secrets` | `mergeWorkgroupAndGroupSecrets` (`src/onecli-secrets.ts`)      |
| `tools` entries (and the scoped host credentials and tool-backed MCP servers they gate) | `tools` | `effectiveTools` (`src/workgroup-access.ts`) |
| MCP servers                              | `mcp_servers`    | `effectiveMcpServers` (`src/fleet-mcp-servers.ts`)             |
| Opt-outs from fleet MCP servers          | `exclude_mcp_servers` | `excludedFleetMcpServers` (`src/fleet-mcp-servers.ts`)    |
| Opt-outs from `~/plugins` entries        | `exclude_plugins` | `effectiveExcludePlugins` (`src/plugin-exclusions.ts`, also run in the container) |

A plugin that carries one tenant's content is scoped to its workgroup separately, by `data/plugin-scopes.json` (see
[Workgroup-scoped plugins](#workgroup-scoped-plugins)); `exclude_plugins` is for a fleet plugin a workgroup does not
want.

Every kind is a **union** (additive, no subtract):

```
secrets     = workgroup.onecli_secrets ∪ container.json.onecliSecrets
tools       = workgroup.tools ∪ container.json.tools     (no tools list in container.json = every surface, unchanged)
mcpServers  = container.json.mcpServers, then workgroup.mcp_servers, then fleet defaults (first one wins per name)
              minus workgroup.exclude_mcp_servers ∪ container.json.excludeMcpServers (fleet entries only)
excluded plugins = workgroup.exclude_plugins ∪ container.json.excludePlugins
```

One exception narrows the secrets union: an agent gets exactly one secret whose host pattern is `opencode.ai`. The
member's own wins over the workgroup's, and the workgroup's over `NANOCLAW_OPENCODE_FLEET_SECRET`; the rest are withheld
at spawn (`resolveSpawnSecrets`, `src/onecli-secrets.ts`), because the gateway resolves two matching secrets in no defined
order. A workgroup that still lists the fleet secret has not declared its own. The capability snapshot keeps the plain
union: it never names a provider key (`PROVIDER_SECRET`, `src/capabilities.ts`), so the two cannot disagree in what an
agent is told.

A member's own declaration can ADD to the workgroup (one sibling alone needs `Datafold-Example-Retail`), or replace a
workgroup MCP server by declaring the same name, and can opt out of more. It cannot SUBTRACT: `excludeMcpServers`
withholds fleet defaults only, so no sibling silently weakens what the workgroup granted, and no sibling can take back
a workgroup opt-out. A member that should not have something the others share keeps it at group level on the members
that need it instead. Opt-outs withhold fleet-wide defaults; a workgroup's own grant is never withheld, and
`add-exclusion` refuses to exclude one.

Wiki actors (`wikiMaintenance`) run the base runtime only and inherit no workgroup access. A child made by
`create_agent` joins its parent's workgroup and inherits all of it; the approval card says so.

### Granting access (the default path)

```bash
ncl secrets grant --name <vault name> --workgroups <workgroup-id>
ncl groups config add-tool --workgroup <workgroup-id> --tool <name[:scope]>
ncl groups config add-mcp-server --workgroup <workgroup-id> --name <server> --url <https-url> ...
ncl groups config add-exclusion --workgroup <workgroup-id> --mcp-server <name>   # or --plugin <dir>[/<sub-path>]
ncl groups config get --workgroup <workgroup-id>          # what the workgroup grants and withholds, and its members
```

For access only one member should have, `ncl secrets grant --groups` and `add-mcp-server --id <group-id>` target that
group; a tool for one member alone is a hand edit of its container.json `tools`. `ncl secrets intake` and
`ncl secrets grant` called by an agent with no target grant to its own workgroup; `ncl integrations complete`
declares a new OAuth bearer on the owning group's workgroup (a bearer already declared in the group's container.json
stays there). A group-scoped agent may name only its own workgroup; `add-tool`/`remove-tool` and
`add-exclusion`/`remove-exclusion` are operator-only, and neither tools nor opt-outs have an `--id` form.

### Credentials one workgroup owns

`flowctl`'s Estuary key is looked up as `FLOW_AUTH_TOKEN_<WORKGROUP>` (the workgroup id, upper-cased, `-` → `_`), so
only that workgroup's members reach it, whatever they declare. It is forwarded only on an explicit `flowctl` entry in
the workgroup's `tools` or the member's own (`flowctlDeclared`, `src/flowctl-credential.ts`): a member with no tools
list is not given it by that absence, but does receive a workgroup grant. Other host credentials keyed by folder —
`ATLASSIAN_BASE_URL_<FOLDER>`, `LOOKER_*`, `DBT_*`, `GITHUB_TOKEN_<FOLDER>`, GCP key files, the Anthropic OAuth set —
are looked up under each member's `credentialFolder` (default: its own folder). Siblings set it to the workgroup's
base folder, so one host key serves the workgroup. It must name a member of the same workgroup: the spawn refuses any
other folder (`assertCredentialFolderInWorkgroup`, `src/workgroup-access.ts`), so no group can point itself at another
tenant's keys.

Scoped host credentials — Google Workspace accounts (and the email-named `~/.google_workspace_mcp` files),
Gmail and Calendar accounts, Snowflake connections, AWS profiles, dbt profiles, gcloud keys — are staged from a
`tools` entry, and a bare `aws` or `google-workspace` names no tenant. `data/credential-ownership.json` records which
workgroups own each scope, and once it exists staging fails closed: a scope is staged only for the workgroups that own
it, so a scope nobody owns — including every scope of a kind the file does not name — is staged for no workgroup, and a
bare tool (or a member with no tools list) is staged scope by scope from what its workgroup owns, never as a whole
store:

```json
{
  "version": 1,
  "credentials": {
    "google-workspace": { "client-a": ["client-a", "main"] },
    "snowflake": { "client-a": ["client-a", "consulting"] },
    "aws": { "client-a-prod": ["client-a", "consulting"] }
  }
}
```

Kinds are `google-workspace`, `google-workspace-mcp` (scope = file email stem), `gmail` (the unsuffixed `~/.gmail-mcp`
account is `@primary` and keeps the primary path), `calendar`, `snowflake`, `aws`, `dbt`, `gcloud`. An exception — one
workgroup reaching several tenants — is another owner on the scope, never a code path. No file keeps today's staging,
so a deploy alone changes nothing; a file that does not parse aborts the spawn; edits apply at the next spawn. The
policy is host-private: it is never committed, and post-merge host steps install it. Ownership is checked against the
spawn's workgroup, never a group or credential folder. Scoped staging drops store files no scope names. The spawn, the
capability snapshot and the dry run all resolve through `stagedCredentialScopes` (`src/credential-ownership.ts`).
`scripts/credential-ownership-dry-run.ts --policy <proposed.json>` prints, per workgroup, what each member gains or
loses if the proposed file replaced the installed one, and which host scopes it leaves staged for no workgroup.

`scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,...>` replaces a workgroup's whole secret list,
validating every name against the vault before writing.

### Moving existing declarations up

`scripts/lift-workgroup-access.ts` (dry run by default, `--apply` to write, `--workgroup <id>` for one) adds to each
workgroup every secret, tool, MCP server (same name, identical entry), `excludeMcpServers` and `excludePlugins` entry
that all of its members declare, and removes member declarations the workgroup then carries identically. It checks
with the spawn's own resolvers that no member's effective access or opt-outs change, before writing and again after.
Access or opt-outs only some members hold are reported as drift, not lifted, since lifting would change what a member
gets today; so are differing `credentialFolder` values (and one the spawn now refuses) and mounts.

### Approvals channel

A card posted in a thread also goes to whoever must answer it. When the person who asked can answer it, that is a copy
in their DM. When they can't, or no person asked, the card goes once into the workgroup's approvals channel, if one is
set, as a live card that names the thread it came from and who asked. Anyone the card allows can answer it there, and
the copy is deleted when the card resolves, so the channel holds open cards. A click in the channel never counts as
thread access, and "Reject with reason…" clicked there asks for the reason in the clicker's DM. If the post fails (the bot is not in the channel, or the channel is archived), the DM
copy goes instead. Unset, the DM copy goes as before.

```bash
ncl groups config set-approvals-channel --workgroup <workgroup-id> --bot <channel-type> --channel <platform-id>
ncl groups config set-approvals-channel --workgroup <workgroup-id> --clear
```

`--bot` is the adapter that posts and deletes there, and it must be a member of the channel. It needs only
`chat:write`. Slack only: a card is posted there only when that bot and the card's bot are registered Slack bots of
the same team (`approvalsChannelFor`, `src/modules/approvals/approvals-channel.ts`); any other platform keeps the DM
copy, since one bot there can span tenants. The setting is the `approvals_channel` column
on the `workgroups` row and takes effect for the next card.

---

## Staleness window

The reconciler runs on every container spawn, but does NOT propagate explicit
`container.json.workgroup_id` changes to **already-running** containers.
Long-running containers hold their `workgroup_id` from spawn time;
operator-edited `container.json` doesn't reach them until they restart. Removing
the field is not a change request: it preserves the current DB assignment.

For typical NanoClaw operation (containers restart frequently or per-session), this is acceptable. For long-running scenarios, restart the container after editing its `container.json.workgroup_id`. A future `/reconcile-workgroups` admin command could force a re-read without spawn — currently out of scope.

---

## Slug-as-PK trade-off

The workgroup primary key is the human-readable folder slug rather than an opaque UUID. This is operator-friendly (you can look at a `workgroups` table and immediately understand the rows) but trades against rename safety: if you rename a workgroup, every reference in `agent_groups.workgroup_id` needs to be updated atomically (cascade UPDATE).

For an install with a fixed set of workgroups (no rename activity), slug-as-PK is the right shape. Industry direction is toward opaque PKs for systems with rename or cross-install share concerns (e.g., GitHub moved from app slugs to `client_id` in 2024). The CHECK constraint on `workgroups.id` (`GLOB '[a-z]*' AND NOT LIKE 'ag-%'`) prevents future opaque-id contamination as a partial defense.

### Migration tripwire

The slug-as-PK choice should be revisited if either of these happens:

1. **First workgroup rename** — at that point, the cost of operating slug-as-PK starts to exceed the benefit. Migrate to opaque PK with `slug` as a `UNIQUE` column.
2. **First cross-install share** — if workgroup definitions are ever shared across NanoClaw installs (e.g., the same `example-retail` workgroup on multiple machines with potentially conflicting slugs), opaque PK becomes mandatory.

The migration path is well-understood (table rebuild with a new column for the opaque PK + foreign-key cascade update). Not blocked by anything; just deferred until the trade-off changes.

---

## Where things live

| What                                 | Where                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Schema                               | `src/db/migrations/036-workgroup-id.ts`                                                   |
| Per-agent projection                 | `src/db/per-agent-projections.ts` (`buildArchiveProjection`, `buildCentralProjection`)    |
| Trusted pre-turn scope and recall    | `src/modules/memory/pre-turn-context.ts` (`buildPreTurnContext`)                          |
| Container config types               | `src/container-config.ts` (`ContainerConfig.workgroup_id`)                                |
| Spawn-time reconciler                | `src/container-runner.ts` (search for `reconcileWorkgroupAtSpawn`)                        |
| OneCLI secret merge                  | `src/onecli-secrets.ts` (`mergeWorkgroupAndGroupSecrets`)                                 |
| Workgroup access (tools, MCP)        | `src/workgroup-access.ts`, `src/fleet-mcp-servers.ts` (`effectiveMcpServers`)             |
| Scoped credential ownership          | `src/credential-ownership.ts`, `data/credential-ownership.json`, `scripts/credential-ownership-dry-run.ts` |
| FS reconciliation (startup)          | `src/modules/workgroup/fs-reconcile.ts` (`reconcileWorkgroupFsState`)                     |
| Memory canon and compatibility views | `src/modules/workgroup/shared-dirs.ts` (`workgroupMemoryDir`, `reconcileWorkgroupMemory`) |
| Operator CLI                         | `ncl groups config … --workgroup` (`set-approvals-channel` included), `ncl secrets grant --workgroups`, `scripts/set-workgroup-secrets.ts`, `scripts/lift-workgroup-access.ts` |
| Google Drive mirror (host, one-way)  | `scripts/publish-workgroups-drive.sh` — [workgroups-drive-publish.md](workgroups-drive-publish.md) |
| Structural assertion                 | `tests/structural/projection-chokepoint.test.ts`                                          |

Current memory contract: [memory.md](memory.md).
