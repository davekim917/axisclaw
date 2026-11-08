# AxisClaw

An AI workforce you run yourself, from chat, built on NanoClaw. See [README.md](README.md) for what it is and how to install it. Architecture lives in `docs/`.

Internal names are still NanoClaw's: the `ncl` CLI, `nanoclaw.sh`, the `nanoclaw-v2-<slug>` service and the `nanoclaw-agent-v2-<slug>` container image. Docs use them as they appear in the code.

## Quick Context

The host is a single Node process orchestrating per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), and get written into the session's inbound DB, waking a container. The agent-runner polls the DB, calls the agent, and writes back to the outbound DB; the host polls that and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

## Entity Model

`workgroups → agent_groups ⇄ messaging_groups → sessions` (many-to-many via `messaging_group_agents`); `users → user_roles` (owner|admin, global or scoped) `+ agent_group_members`.

A messaging_group is one chat/channel on one platform; an agent_group is one agent identity; a session is the (agent_group, messaging_group, thread) triple owning a container. Easy to get wrong:

- **Privilege is user-level, not agent-group-level** — owner/admin live on `user_roles`. [docs/isolation-model.md](docs/isolation-model.md)
- **Siblings share a workgroup, they don't collapse into one** — the data-pool boundary (chat archive, shared files, OneCLI secrets); each keeps its own bot user, CLAUDE.md, routing identity, engage rules. [docs/workgroups.md](docs/workgroups.md)

Full schema: [docs/db-central.md](docs/db-central.md)

## Databases

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) — one writer per file, no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update; host uses even `seq` numbers, container odd. [docs/db-session.md](docs/db-session.md)

`data/v2.db` holds everything that isn't per-session (migrations: `src/db/migrations/`). For ad-hoc queries use `pnpm exec tsx scripts/q.ts <db> "<sql>"`, not the `sqlite3` CLI (setup avoids that binary; the wrapper uses the installed `better-sqlite3`). [docs/db-central.md](docs/db-central.md)

## Key Files

Most of `src/` is discoverable by reading it. These are the ones you would not guess:

- **`src/guard/`** — the privileged-action decision seam: `guard(action, input)` → allow | hold | deny. `ncl`/delivery actions *demand* a guard at registration; approved replays re-run checks with the approval row as a grant.
- **`src/host-sweep.ts`** — one 60s sweep owns `processing_ack` sync, stale detection, due-message wake, recurrence, ceiling-kill accountability. Anything "on a timer" happens here.
- **`src/router.ts` → `src/delivery.ts`** — the two ends of the message path; everything else hangs off them.
- **`src/group-init.ts`** — the agent-runner source is a boot snapshot (`src/agent-runner-source.ts`) mounted read-only for every group; edits reach a group at its first spawn after the next host restart — an adopted container keeps its old snapshot until it exits (Container Restart).

## Admin CLI (`ncl`)

Queries/modifies the central DB — agent groups, messaging groups, wirings, users, roles, tasks. Host: Unix socket (`src/cli/socket-server.ts`). Container: session-DB transport (`container/agent-runner/src/cli/ncl.ts`). `ncl help` / `ncl <resource> help` are generated from the registry; don't mirror them here.

## Channels and Providers

Slack and Discord adapters ship in `src/channels/`; the Claude, Codex and OpenCode providers ship in `container/agent-runner/src/providers/`. Other channels install from NanoClaw's long-lived `channels` branch through idempotent `/add-<name>` skills, which carry their install steps as `nc:` directive fences applied by the engine (`scripts/skill-apply.ts`). [docs/skill-directives.md](docs/skill-directives.md)

**Channel defaults** are exactly two levels — the adapter's `ChannelDefaults` declaration and the per-wiring override at creation, no per-instance DB config table. A stale/undeclared adapter falls back to behavior-faithful defaults. [docs/api-details.md](docs/api-details.md#channel-defaults)

## Self-Modification

`install_packages`/`add_mcp_server` edit an agent group's container config (deps, MCP wiring) behind a single admin approval; `src/modules/self-mod/apply.ts` rebuilds the image if needed and respawns via `on_wake` (race semantics under Container Restart). `container/agent-runner/src/mcp-tools/self-mod.ts`

## Container Config

Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts) is split across two stores. `groups/<folder>/container.json` is authoritative: the spawn path reads it (`readContainerConfig`), bind-mounts it read-only, and the runner reads `provider`/`model`/`effort` from it — no DB→file materialization at spawn, only identity fields (`agentGroupId`, `groupName`) sync. `container_configs` (central DB) is a read-side projection for `-m`/`-e` flag vocabulary, scheduled-task validation, and image builds.

`ncl groups config get/update` and the self-mod MCP tools manage both: `config update` writes `provider`/`model`/`effort` to the DB row *and* mirrors them into `container.json`, so a provider change takes effect next restart — writing only the DB row leaves the container booting its old provider.

**Fleet-wide MCP servers are data, not code.** `data/fleet-mcp-servers.json` (`ncl groups config add-mcp-server --fleet …`) holds the servers every group inherits; a group's own `container.json` entry wins for that name, then its workgroup's, and the workgroup's or the group's `excludeMcpServers` withholds a fleet one. One function, `effectiveMcpServers` (`src/fleet-mcp-servers.ts`), serves both the spawn and the capability snapshot. [docs/fleet-mcp-servers.md](docs/fleet-mcp-servers.md)

**`cli_scope`** controls what the agent can do with `ncl` in-container:

| Value | Behavior |
|-------|----------|
| `disabled` | Agent never learns about ncl (excluded from CLAUDE.md); host rejects any `cli_request`. |
| `group` (default) | Scoped to own agent group (`groups`, `sessions`, `destinations`, `members`, `tasks`, `secrets`); `--id` auto-filled; cross-group access rejected; `cli_scope` changes blocked. |
| `global` | Unrestricted. Set only by `scripts/init-first-agent.ts --role owner` — not implied by ownership; zero `global` groups is valid and tighter-than-default, never a drift to "fix" by widening. |

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. With `--message` the host writes an `on_wake` row and respawns via `onExit`; without one, the container waits for the next message. In-container, `--id` auto-fills and only the calling session restarts.

**`on_wake` closes a race**: only picked up on a fresh container's *first* poll, so a dying container still in its SIGTERM grace period can't steal it — `killContainer`'s `onExit` guarantees the old process is gone first.

**Kills are accounted for publicly.** The 30-min idle ceiling (`ABSOLUTE_CEILING_MS`) killing resumable work queues a deferred `ceiling-respawn-*` wake; the fresh container must post done/lost/next (narration is never recovery evidence), capped at `WORK_CONTINUATION_RESUME_MAX_ATTEMPTS` — `decideCeilingFollowUp` in `src/host-sweep.ts`. The 15-min chat idle reap stays unconditional, but uncommitted or unpushed topic-checkout work the killed container made itself (`container/agent-runner/src/worktree-in-flight.ts`), or an unfinished task list, earns a `reap-respawn-*` wake under the same contract (`followUpKill`, `src/modules/sweep-continuation/reap-respawn.ts`). `continue_work({ task })` is the only sanctioned way to promise follow-up — future-tense prose has no control effect. `wait` wakes in-thread, same session; `ncl tasks` runs in its own task session, and each scheduled fire starts a fresh conversation unless the series is `--continuous`. Full semantics: [docs/agent-runner-details.md](docs/agent-runner-details.md).

**A host restart does not stop running containers**: `planContainerShutdown()` leaves every one for the next host to adopt (`adoptRunningSessions`, `src/container-runner.ts`). Boot stops only a container it cannot adopt — over the memory admission budget, a duplicate for its session, or a session that cannot take a wake — and only those sessions get a deduped `host-restart-*` note. An adopted container keeps its spawn-time image, env and runner snapshot until it exits, so a deploy reaches a running session only at its next spawn.

## Secrets / Credentials / OneCLI

Secrets live in the OneCLI gateway, injected per-request at the proxy boundary — never env vars, chat, or on-disk. `src/onecli-secrets.ts`, `container/skills/onecli-gateway/SKILL.md`.

**Remote MCP servers use OAuth, not a pasted key**: `ncl integrations login|complete|list|remove` runs MCP authorization (discovery → dynamic client registration → PKCE authorization-code), writes the access token into the group's bearer secret, and a sweep duty keeps it fresh. The refresh token is host-side (`data/mcp-oauth/`, 0600) because OneCLI secret values are **write-only**. [docs/mcp-oauth-integrations.md](docs/mcp-oauth-integrations.md)

**API keys arrive through a form, never chat**: `ncl secrets intake` posts a card into the requesting thread whose Slack or Discord modal writes the value straight to the vault (`src/modules/secret-intake/`); the requester only learns "stored". `ncl secrets grant` adds an existing name to groups/workgroups. Pending intakes are in memory — a host restart expires them. [docs/secret-intake.md](docs/secret-intake.md)

**Fail-closed, declarative scoping**: `container.json`'s `onecliSecrets` (names/UUIDs) resolves and assigns on every spawn; an unresolvable name aborts the spawn (the sweep retries). Workgroup secrets merge as a union with per-group additions — extend only, never subtract. [docs/workgroups.md](docs/workgroups.md) **Gotcha — auto-created agents default to `selective` mode with nothing assigned**: symptom is a `401` from an API whose credential *is* in the vault; fix is declaring `onecliSecrets` above, or `onecli agents set-secrets` / `set-secret-mode --mode all` (looser). Approval gating is two-sided — a configured gateway rule with no host callback running hangs every credentialed call until timeout.

## Skills

Four types — channel/provider installers, utility skills that ship code, instruction-only operational skills, container skills mounted into agent sessions. Authoring checklist: [docs/skill-guidelines.md](docs/skill-guidelines.md). Descriptions are the discovery mechanism — read `.claude/skills/*/SKILL.md` and `container/skills/*/SKILL.md`, not a list here.

## Making Changes

**Verify another module's behaviour before relying on it.** A branch that rests on how some other module behaves — what a predicate returns for a missing file, whether a subclass overrides a method, what an existence check keys on — must be checked against the source first. An unverified premise does not fail loudly: it produces code that looks right and a test that paraphrases the same wrong belief and passes. Read the whole declaration, since guard clauses live on the first lines.

**A constraint belongs in a test, type, assert or lint rule; a comment is only for what code can't check** — an external system's quirk, why the obvious approach was wrong. No narration of what the code does, no change history. Tooling directives (`eslint-disable`, `@ts-expect-error`) are not comments in this sense and stay.

Dead code, copy-paste clones and history in comments are flagged by `scripts/hygiene/run.ts`. Beyond correctness, check for hard-coded values that belong in config, a new helper where one already exists, and logic copied across modules instead of centralised.

## Development

```bash
# Host (Node + pnpm)
pnpm run dev          # tsx, no watch
pnpm run build        # compile src/
./container/build.sh  # rebuild the agent image
pnpm test             # vitest
pnpm run lint         # typed eslint

# Agent-runner (Bun — separate package tree)
cd container/agent-runner && bun install   # after editing deps
cd container/agent-runner && bun run test  # bun:test + hermeticity
```

Container typecheck is a separate tsconfig — after editing `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (or `bun run typecheck` from that dir).

**A worktree gets its own install, never a link to the live one.** From the worktree: `pnpm install --frozen-lockfile --offline` and, for runner work, `cd container/agent-runner && bun install --frozen-lockfile`. pnpm resolves `node_modules` through a symlink and rewrites the target, so `.pnpmfile.cjs` refuses to run pnpm at all while `node_modules` is a link.

**On a machine that is also running the host, run the test files for what you touched, not the full suite** (`node_modules/.bin/vitest run <files> --maxWorkers=2`, at low CPU and IO priority). The full suite is heavy enough to starve live agents.

The host runs as a service named `nanoclaw-v2-<slug>`: a systemd user unit, a system unit when setup ran as root, or a launchd agent on macOS (`setup/service.ts`).

## Module System (host)

Host (`src/`) is ESM. Never use `require()` — `@typescript-eslint/no-require-imports` disables hide a runtime trap: `require` is undefined in built ESM, so the call typechecks but throws/returns null at runtime. For circular imports use `await import('./mod.js')`. Agent-runner (`container/agent-runner/`) is a separate Bun package tree; this rule is host-only.

## Troubleshooting

Check these first when something goes wrong:

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first (failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full chain |
| Setup logs | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db`/`messages_in` (reached container?), `outbound.db`/`messages_out` (agent responded?) |
| Post-restart health | `grep 'OneCLI preflight ok' logs/nanoclaw.log` — adapter counts are not proof; a host that cannot reach the OneCLI control API refuses every spawn at WARN |
| Post-deploy inbound | `logs/post-deploy-inbound.json` — per-platform verdict from live inbound in the 30 min after every boot; a platform whose inbound-path adapter errors match or outnumber its routed messages is `failing`. `running` or `unverified` is not healthy, and preflight alone never is |

Container logs vanish on exit (`--rm`); a silent in-container failure leaves nothing to inspect.

## Timestamps

Two rules, no exceptions:

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC, `Z`). Never `datetime('now')`: its naive `YYYY-MM-DD HH:MM:SS` parses as local time in `new Date()` and breaks string comparisons against ISO values. Pure SQL uses `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; SQL comparisons wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or user renders in the install timezone via `formatLocalTime`/`formatLocalStamp` (`src/timezone.ts`, runner `timezone.ts`); `--json`, DB values and setup logs stay ISO. Host log lines are stamped in the host process's local time followed by an explicit numeric UTC offset (`ts()`, `src/log.ts`): `[2026-09-22 08:50:37.011-04:00]`. That zone can differ from the install timezone, so **never rebuild the instant from the wall-clock parts** — parse with `parseLogStamp` (`src/log.ts`).

An agent group can override the install timezone: `ncl groups config update --timezone <IANA>` (`""` clears). The value is validated against the zone database on disk (`/usr/share/zoneinfo`) and stored verbatim, because the container opens it as a case-sensitive POSIX `TZ` path. Validation fails closed: fixed offsets, abbreviations, wrong case and retired aliases are refused. ICU is never the fallback authority — it maps `Asia/Kolkata` onto `Asia/Calcutta`, whose backward-link file current tzdata omits. **An already-armed occurrence keeps the absolute instant it was armed at**: a live series moves onto the new grid at its next re-arm. Every caller that needs a group's timezone goes through one resolver, `resolveGroupTimezone` in `src/container-config.ts`.

## Supply Chain Security (pnpm)

Tracks latest stable, including majors; prerelease/beta/RC/dev/nightly/draft/yanked releases are rejected. Flow: [docs/dependency-updates.md](docs/dependency-updates.md).

- **`allowBuilds`**: never add packages without review — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** in CI/automation/container builds — never bare `pnpm install` there.
- **Exact resolution**: commit manifests with regenerated lockfiles; Docker/runtime tools stay exact-pinned.
- **Dependency gate** (`scripts/dependency-gate.ts`): a runtime version change needs a `docs/dependency-changes/` ledger mapping each changelog behaviour change to a test or a reason. Never reclassify a package to get a bump through.

## Container Runtime (Bun)

Agent container: **Bun**. Host: **Node**/pnpm — no shared modules, only session DBs. Buildkit caches the build context aggressively — `--no-cache` alone does NOT invalidate COPY steps; prune the builder, then re-run `./container/build.sh`. Full gotcha list: [docs/build-and-runtime.md](docs/build-and-runtime.md). Three silent-failure traps:

- **`container/agent-runner/` is not a pnpm workspace.** `bun install` there, commit `bun.lock` — `pnpm install` corrupts it.
- **Named SQL params need the prefix in JS keys too.** `bun:sqlite` doesn't auto-strip `$`/`@`/`:` the way `better-sqlite3` does on the host — use `$name` in both SQL and `.run({ $id: msg.id })`. Positional `?` works normally.
- **Session-DB pragmas**: `journal_mode=DELETE` (`container/agent-runner/src/mailbox/sqlite/connection.ts`) is load-bearing for cross-mount visibility — read the comment block there first.

## Docs Index

| Topic | Doc |
|---|---|
| Architecture | `architecture.md`, `architecture-diagram.md` |
| DB model | `db.md` → `db-central.md`, `db-session.md` |
| Host API | `api-details.md` |
| Agent-runner, MCP tools | `agent-runner-details.md` |
| Isolation levels | `isolation-model.md` |
| Workgroups | `workgroups.md`, `workgroup-read-access.md` |
| Skills | `skills-model.md`, `skill-guidelines.md`, `skill-directives.md`, `skill-engine-seam.md` |
| Fleet MCP defaults | `fleet-mcp-servers.md` |
| Remote MCP OAuth | `mcp-oauth-integrations.md` |
| Secret intake | `secret-intake.md` |
| Runtime, CI | `build-and-runtime.md` |
| Dependency updates | `dependency-updates.md` |
| Provider switching | `provider-migration.md` |
| Provider fallback | `provider-fallback.md` |
| Templates | `templates.md` |
| Memory | `memory.md` |
| Setup, customizing | `setup-wiring.md`, `customizing.md` |

## CJK font support

Off by default (~200MB). Signals: CJK conversation, `Asia/Tokyo|Shanghai|Seoul|Taipei|Hong_Kong` timezone, "tofu" rectangles in screenshots/PDFs. Offer `INSTALL_CJK_FONTS=true` in `.env` + rebuild.
