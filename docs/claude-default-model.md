# Migration: the Claude default model

## Current: Fable default effort `high` (2026-11-11)

This section is the current migration. No model moves and no pin is rewritten. Only the Fable family default effort moves.

**What moves.** `defaultEffortForModel` (`container/agent-runner/src/providers/claude.ts`) returns `high`, not `medium`, for the word `fable` and every `claude-fable-*` id. Opus, Sonnet and Haiku defaults do not move, and the effort clamp does not change. A path moves only when **no layer sets an effort**, because the family default is the last step of the runner's chain: `input.effort ?? stickyConfig.effort ?? NANOCLAW_EFFORT_OVERRIDE ?? defaultEffortForModel(model)`, at query start and again in `applySettings` after a live `-m fable`. Every explicit pin keeps its value: a chat `-e`, a session sticky, `container.json` `providerConfig.effort`, a wiring `default_effort` or `container.json` `effort` / `defaultEffort` (folded into `NANOCLAW_EFFORT_OVERRIDE`), a Claude `providerFallback.effort`, a task `effort_pin`, and a subagent's frontmatter `effort:`.

**Detect.** Paths that move run Fable with none of those layers set. List the Fable pins, then run the effort-pin listing in **History: 2026-09-24** below; a Fable path that appears in the first list and not the second moves to `high`.

```bash
grep -HiE '"(model|defaultModel)": *"[^"]*fable' groups/*/container.json
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mga.agent_group_id, mga.default_model, mga.default_effort from messaging_group_agents mga where lower(coalesce(mga.default_model,'')) like '%fable%'"
ncl tasks list --json | grep -iE -B2 -A2 '"model_pin": "[^"]*fable'
```

**Why.** Anthropic's prompting guidance for Fable 5.2 says to start at `high`, and that the model stops early more often at `low` and `medium`. Operator decision, 2026-11-11. `high` thinks more than `medium`, so a moved path costs more per turn.

**Fix: keep `medium` on a Fable path.** Pin it before deploying:

```bash
ncl groups config update --id <group-id> --effort medium        # group
ncl wirings update <wiring-id> --default-effort medium          # one channel
ncl tasks update --id <series> --group <group-id> --effort medium
```

**Deploy.** Agent-runner source only, no new dependencies, so no image rebuild. The runner source is a boot snapshot taken at host start (`src/agent-runner-source.ts`), so a **host restart** makes it live. Running containers are adopted across the restart and keep the snapshot they spawned with until they exit; recycle one sooner with `ncl groups restart --id <group-id>`.

**Verify.** A Fable turn from a container spawned after the restart, on a path with no effort pin, writes `turn_usage` with `effort = 'high'` and `effort_requested = 'high'`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, effort_requested, count(*), round(avg(cost_usd),3) from turn_usage where model like '%fable%' and ts > '<restart time>' group by 1,2,3"
```

`turn_usage` records the effort a turn ran at, not which layer chose it, so a `medium` Fable row after the restart is either a pin or an adopted container. A NULL effort is either a subagent's row (the same `turn_id` also has a row for the parent's model) or a main-model turn whose effort changed mid-turn; neither shows what the default chose.

**Rollback.** Change the Fable line of `defaultEffortForModel` back to `medium` through a PR, merge, and redeploy (host restart). No pin was written, so there is nothing to unpin.

---

## History: 2026-11-11 — subagents default to Opus

This section was the current migration. No family default model or effort moves, and no pin is rewritten. What moves is the model a Claude subagent runs when nothing names one.

**What moves.** `claudeSpawnEnv` (`src/claude-spawn-defaults.ts`) now sets `CLAUDE_CODE_SUBAGENT_MODEL` to `DEFAULT_OPUS_MODEL` (`claude-opus-5-5[1m]`) in every Claude container, agent and wiki alike. A subagent whose Agent call names no model and whose definition has no `model` field (`general-purpose`, the `bootstrap-orchestrate:worker-*` shims, a group or plugin agent without `model:`) used to inherit its parent's model and now runs Opus. A session on Fable or Sonnet therefore builds with Opus subagents. The variable follows `DEFAULT_OPUS_MODEL`, so a later Opus bump moves it too. Codex and OpenCode are untouched.

What does **not** move, on the pinned CLI (2.1.322):
- a model named on the Agent call (`model: "sonnet"`) wins;
- a `model:` field in the agent definition wins, `model: inherit` included (that one keeps the parent's model);
- an Opus parent's unnamed subagents already ran Opus.

`container/agent-runner/src/providers/claude-live-path.test.ts` ("subagent model precedence") drives the real SDK and CLI and asserts all of these, with a control showing an unnamed subagent inherits when the variable is absent. If a CLI bump changes the ranking, that test fails.

A group's `.claude-shared/settings.json` cannot pin the variable: the CLI applies settings `env` over the process env, so group-init (`DEPRECATED_ENV`, `src/group-init.ts`) scrubs the key on every spawn, as it does for the family aliases.

**Detect.** Paths that move are subagents spawned with no model from a parent not on Opus. Check which parents those are:

```bash
# 1. Groups, wirings and tasks pinned off Opus (their unnamed subagents move):
grep -HiE '"(model|defaultModel)": *"[^"]*(sonnet|fable|haiku)' groups/*/container.json
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, mga.agent_group_id, mga.default_model from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id where lower(coalesce(mga.default_model,'')) like '%sonnet%' or lower(coalesce(mga.default_model,'')) like '%fable%' or lower(coalesce(mga.default_model,'')) like '%haiku%'"
ncl tasks list --json | grep -iE -B1 -A1 '"model_pin": "[^"]*(sonnet|fable|haiku)'
# 2. Subagent definitions that name no model (they follow the new default under any parent):
grep -rLE '^model:' groups/*/.claude/agents/*.md; find ~/plugins -path '*/agents/*.md' -not -path '*/node_modules/*' -exec grep -LE '^model:' {} +
# 3. A settings pin, which group-init scrubs at the next spawn:
grep -l CLAUDE_CODE_SUBAGENT_MODEL data/v2-sessions/*/.claude-shared/settings.json
```

**Why.** A Fable session orchestrates and Opus builds, the same split the host's own Claude Code runs with. Without the variable a subagent with no model inherits the parent's, so a Fable or Sonnet session also built with Fable or Sonnet.

**Fix: keep a subagent on its parent's model.** There is no per-group setting. Give the definition `model: inherit`, or have the Agent call name a model. Both outrank the variable.

**Deploy.** `scripts/deploy.sh`: the value is a spawn `-e` in compiled host code, so the host must be rebuilt and restarted. The script also rebuilds the agent image because `container/` changed, though the runner change is only a comment and tests. A host restart **adopts** running containers, which keep their spawn-time env, so an adopted container keeps inheriting until it exits. Recycle a group with `ncl groups restart --id <group-id>` at a quiet moment.

**Verify.**

```bash
docker inspect <fresh claude container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep CLAUDE_CODE_SUBAGENT_MODEL
# In a fresh session of a Fable- or Sonnet-pinned group, have the agent spawn a `general-purpose` subagent with no model, then read the models the parent and the subagent ran:
grep -ho '"model":"claude-[^"]*"' data/v2-sessions/<group-id>/<session-id>/.claude-projects/*/<transcript-uuid>.jsonl | sort | uniq -c
grep -ho '"model":"claude-[^"]*"' data/v2-sessions/<group-id>/<session-id>/.claude-projects/*/<transcript-uuid>/subagents/*.jsonl | sort | uniq -c
```

Expect `CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5[1m]`, the parent transcript on Fable or Sonnet, and the subagent transcript on `claude-opus-5-5`. `turn_usage` cannot show this: it has one row per model per turn and no parent/child split, so an Opus parent with a Sonnet-named child looks the same as a Sonnet parent with an Opus child.

**Rollback.** `scripts/deploy.sh` deploys only what is on `origin/main`: it refuses a checkout with tracked edits, then checks out and pulls `main`. So land the rollback there first. Open a PR that reverts this change (`git revert <merge commit>`), or that removes both elements of the pair in `claudeSpawnEnv` (the `'-e'` and the `CLAUDE_CODE_SUBAGENT_MODEL=…` string after it; a lone `'-e'` breaks every spawn) together with the test lines that assert it. Merge it, then run `scripts/deploy.sh`. Containers spawned after that inherit again; check one with the `docker inspect` line above, which should print nothing.

---

## History: 2026-11-10 — Fable default moves to 5.2

_Historical. Its effort bullet (Fable at `medium`) is superseded by **2026-11-11 — Fable default effort `high`**; the model half (`claude-fable-5-2[1m]`) is current._

Opus, Sonnet and Haiku defaults do not move, and no family default effort moves. The Fable family default model and the container's pinned CLI move.

**What moves.**
- `DEFAULT_FABLE_MODEL` (`src/flag-parser.ts`) is `claude-fable-5-2[1m]`, was `claude-fable-5-1[1m]`. Every Claude path whose model resolves through the word `fable` runs Fable 5.2: a chat `-m fable`, a `fable` wiring, group, task or `providerFallback` pin, a subagent's `model: fable`, and any call the CLI makes through the word (resolved through `ANTHROPIC_DEFAULT_FABLE_MODEL`, which `claudeSpawnEnv` sets from the same constant). Unpinned groups resolve to Opus and do not move.
- A frozen id (`claude-fable-5-1[1m]`, `claude-fable-5[1m]`) or version alias (`fable51`, `fable5`, …) does **not** move. New pinned aliases: `fable52` / `fable5-2` / `fable-5-2`.
- Effort does not move: `defaultEffortForModel` gives `medium` to the word `fable` and every `claude-fable-*` id wherever no layer sets an effort, as before. Fable 5.2 takes `-e low` through `max`.

Fable 5.2 is listed at $8 / $40 per MTok with $0.20 cache reads, with a 1M context window (Claude Code 2.1.321 changelog).

**Detect.** A path moves when its chain ends at the word `fable`. A path that names Fable by full id or version alias stays where it is; to make it follow this and every later bump, repin it to `fable`. Check every layer:

```bash
# 1. Groups: model / legacy defaultModel / providerConfig.model / providerFallback.model (indented lines are inside providerConfig or providerFallback)
grep -HiE '"(model|defaultModel)": *"(fable|claude-fable-[^"]*|fable[0-9-]+)"' groups/*/container.json
# 2. Channel wirings
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, mga.agent_group_id, mga.default_model, mga.default_effort from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id where lower(coalesce(mga.default_model,'')) like '%fable%'"
# 3. Task series (pending and paused; repeat after in-flight fires finish)
ncl tasks list --json | grep -iB1 -A1 '"model_pin": "[^"]*fable'
# 4. Subagent frontmatter (group-local, then plugin agents)
grep -rHiE '^model: *[^ ]*fable' groups/*/.claude/agents; find ~/plugins -type d -name agents -not -path '*/node_modules/*' -exec grep -rHiE '^model: *[^ ]*fable' {} +
# 5. Session stickies: run the sticky sweep in History: 2026-09-22 (Detect §4) and look for `fable`.
```

Precedence facts that decide whether a repin takes effect:
- A pure scheduled-task fire ignores session stickies (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts`).
- A group's `providerConfig.model` outranks the channel wiring (`container/agent-runner/src/providers/claude.ts`: `input.model ?? stickyConfig.model ?? NANOCLAW_CLAUDE_MODEL ?? ANTHROPIC_DEFAULT_OPUS_MODEL`), so a wiring change does nothing for a group whose `providerConfig` sets a model.
- `providerConfig.model`, `providerFallback.model` and legacy `defaultModel` have no `ncl` verb; edit `groups/<g>/container.json` directly (check `git -C groups status` first).

**Why.** Fable 5.2 replaces Fable 5.1 as Anthropic's Fable model. The container CLI must know the id: an id the CLI binary does not contain silently loses its family behaviour (1M window, effort ladder). 2.1.302 has no `claude-fable-5-2`; 2.1.321 adds it. This change pins exactly claude-code 2.1.322, with agent SDK 0.3.322 in the same patch (`setup/lib/image-version-pins.test.ts` enforces the pair and `versions.json`). Behaviour changes in between: [docs/dependency-changes/2026-11-10-claude-code-2.1.322.md](dependency-changes/2026-11-10-claude-code-2.1.322.md).

**Fix: keep Fable 5.1 on a path, before deploying.** Pins are data and take effect without a deploy:

```bash
ncl groups config update --id <group-id> --model claude-fable-5-1[1m]
ncl wirings update <wiring-id> --default-model claude-fable-5-1[1m]
ncl tasks repin --all --from-model fable --to-model claude-fable-5-1[1m] --dry-run   # literal match; apply without --dry-run
```

The reverse, making a frozen path follow the family after deploy: `--model fable` / `--default-model fable` / `ncl tasks repin --all --from-model claude-fable-5-1[1m] --to-model fable` (repeat per frozen spelling the Detect step found). Never pin a live task or wiring to `claude-fable-5-2[1m]` or to `fable` while its container still runs the old CLI (see Deploy).

**Deploy.** In this order:
1. `scripts/deploy.sh`. It rebuilds the base agent image because `container/` changed, then restarts the host in the same run, with no pause between the two. The rebuild is required: the SDK bump changes the runner's deps hash, and `src/agent-runner-image-check.ts` refuses a spawn from an image whose hash does not match.
2. Right after the restart, rebuild every `imageTag` group's image (`grep -lE '"imageTag"' groups/*/container.json`). A package image (tag `<image base>:<group-id>`, built by `install_packages`) carries the deps label, so until it is rebuilt that group's new spawns are refused with `Refusing spawn — agent image drift`. Rebuild it with `ncl groups restart --id <group-id> --rebuild`, which also recycles the group's containers. Any other tag is an operator image: one with no deps label passes the check with a warning and would run its old CLI with the new `ANTHROPIC_DEFAULT_FABLE_MODEL`, so rebuild it with its own process on the new base.

A host restart **adopts** running containers, which keep their spawn-time runner, CLI and `ANTHROPIC_DEFAULT_FABLE_MODEL`, so a `fable` pin in an adopted container still means Fable 5.1 until it exits. Recycle a group with `ncl groups restart --id <group-id>` at a quiet moment.

**Verify.**

```bash
docker inspect <fresh claude container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ANTHROPIC_DEFAULT_FABLE_MODEL
docker exec <fresh claude container> claude --version
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*) from turn_usage where ts > '<deploy time>' and model like '%fable%' group by 1,2"
```

Expect `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-2[1m]`, CLI 2.1.322, and Fable rows from fresh containers on `claude-fable-5-2` at `medium` where nothing set an effort. Unpinned groups run Opus, so the bump shows in `turn_usage` only on a turn pinned to Fable. A container that still reads `claude-fable-5-1[1m]` was spawned before the deploy.

**Rollback.**
- **One path:** apply the Fix commands above, then `ncl groups restart --id <group-id>`.
- **The fleet default:** set `DEFAULT_FABLE_MODEL` back to `claude-fable-5-1[1m]` and redeploy. The CLI/SDK pins can stay: 2.1.322 still carries `claude-fable-5-1`.

---

## History: 2026-10-18 — Haiku default moves to 5.5

Opus, Sonnet and Fable defaults do not move. The Haiku family default (model and effort), the container's pinned CLI, and the host's own Haiku calls (thread and session titles, now through the Claude Code CLI) move.

**What moves.**
- `DEFAULT_HAIKU_MODEL` (`src/flag-parser.ts`) is `claude-haiku-5-5`, was `claude-haiku-4-5-20251001`. Every Claude path whose model resolves through the word `haiku` runs Haiku 5.5: a chat `-m haiku`, a `haiku` wiring, group, task or `providerFallback` pin, a subagent's `model: haiku`, and any call the CLI itself makes through the word (the CLI resolves it through `ANTHROPIC_DEFAULT_HAIKU_MODEL`, which `claudeSpawnEnv` sets from the same constant). A frozen `claude-haiku-4-5` id or its `haiku45` alias keeps Haiku 4.5. New pinned aliases: `haiku55` / `haiku5-5` / `haiku-5-5`.
- Haiku 5.5 takes effort (`low` through `max`); Haiku 4.5 does not. `-e` on `haiku` is now applied instead of skipped with a warning. Where no layer sets an effort, `defaultEffortForModel` returns `medium`, Anthropic's own default for 5.5, for the word and every `claude-haiku-*` id except `claude-haiku-4-*`, which still gets none and still drops an explicit effort.
- The host's Haiku calls (`callHaiku`, `src/llm.ts`: Discord thread titles and dashboard session titles) run Haiku 5.5 through the Claude Code CLI (`claude -p`, effort `low`, no tools, settings or session, config isolated in `data/claude-title-cli/`), one subscription slot at a time. On raw `/v1/messages` a subscription OAuth token refuses Haiku 5.5 with `429 rate_limit_error: Error` for a caller that is not Claude Code, so the raw call they used to make stays on Haiku 4.5 or nothing. The host needs `claude` on the service `PATH`. `NANOCLAW_SESSION_TITLE_MODEL` still overrides the model for session titles.
- Claude Code 2.1.302 turns fork subagents on in SDK sessions. The Claude spawn env (`claudeSpawnEnv`, agent and wiki containers alike) now sets `CLAUDE_CODE_FORK_SUBAGENT=0`, so container behaviour does not change.

Haiku 5.5 costs $0.10 / $0.50 per MTok for prompts up to 100K tokens and $0.50 / $2.50 above, against $1 / $5 for Haiku 4.5. It has a 1M context window natively, so no `[1m]` suffix, and the same text counts as about 30% more tokens.

**Detect.** A path moves when its chain ends at the word `haiku`. Check every layer:

```bash
grep -HE '"(model|defaultModel)": *"haiku"' groups/*/container.json
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, mga.agent_group_id, mga.default_model from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id where lower(coalesce(mga.default_model,'')) = 'haiku'"
ncl tasks list --json | grep -B1 -A1 '"model_pin": "haiku"'
grep -rHE '^model: *haiku' groups/*/.claude/agents; find ~/plugins -type d -name agents -not -path '*/node_modules/*' -exec grep -rHE '^model: *haiku' {} +
grep -E '^NANOCLAW_SESSION_TITLE_MODEL=' .env
```

For session stickies, run the sticky sweep in History: 2026-09-22 (Detect §4) and look for `haiku`. The precedence notes in History: 2026-09-29 (stickies, `providerConfig.model`, support-poller pins) apply unchanged.

**Why.** Haiku 5.5 replaces Haiku 4.5 at a tenth of the price, with a larger context window and better instruction following. The container CLI must know the id. 2.1.290 has no `claude-haiku-5-5` in its model catalog, and 2.1.302 lists it with adaptive thinking and the effort ladder. This change pins exactly 2.1.302, with agent SDK 0.3.302 in the same patch.

**Fix: keep Haiku 4.5 on a path, before deploying.**

```bash
ncl groups config update --id <group-id> --model claude-haiku-4-5
ncl wirings update <wiring-id> --default-model claude-haiku-4-5
ncl tasks repin --all --from-model haiku --to-model claude-haiku-4-5 --dry-run   # literal match; apply without --dry-run
```

Edit `providerConfig.model`, `providerFallback.model` and legacy `defaultModel` in `groups/<g>/container.json` directly.

**Deploy.** Run `scripts/deploy.sh`. It rebuilds the agent image because `container/` changed, and the SDK bump changes the runner's deps hash, so spawns from the old image are refused until the image matches. Rebuild every `imageTag` group's image before the host restart (`grep -lE '"imageTag"' groups/*/container.json`). A host restart adopts running containers, which keep their spawn-time CLI and `ANTHROPIC_DEFAULT_HAIKU_MODEL`; recycle a group with `ncl groups restart --id <group-id>` at a quiet moment.

**Verify.**

```bash
docker inspect <fresh claude container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ANTHROPIC_DEFAULT_HAIKU_MODEL
docker exec <fresh claude container> claude --version
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*) from turn_usage where ts > '<deploy time>' and model like '%haiku%' group by 1,2"
```

Expect `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5`, CLI 2.1.302, and Haiku rows from fresh containers on `claude-haiku-5-5`. For titles, new dashboard session titles keep appearing, and `logs/nanoclaw.log` shows no new `callHaiku: claude CLI` failures.

**Rollback.**
- **One path:** apply the Fix commands above, then `ncl groups restart --id <group-id>`.
- **The fleet default:** set `DEFAULT_HAIKU_MODEL` back to `claude-haiku-4-5-20251001` and redeploy. The effort changes can stay, since Haiku 4.5 ids still get none, and so can the CLI/SDK pins, since 2.1.302 still serves Haiku 4.5.

---

## History: 2026-09-29 — Sonnet default moves to 5.5

Opus and Fable defaults do not move (see **History: 2026-09-24** and **History: 2026-09-22** below). Only the Sonnet family default (model and effort) and the container's pinned CLI move.

**What moves.** `DEFAULT_SONNET_MODEL` (`src/flag-parser.ts`) is `claude-sonnet-5-5`, was `claude-sonnet-5`. On deploy, every Claude path whose model resolves through the word `sonnet` runs Sonnet 5.5: a chat `-m sonnet`, a `sonnet` wiring, group, task or `providerFallback` pin, and a subagent's `model: sonnet` (the CLI resolves the word through `ANTHROPIC_DEFAULT_SONNET_MODEL`, which `claudeSpawnEnv`, `src/claude-spawn-defaults.ts`, sets from the same constant). Unpinned groups resolve to Opus and do not move. A frozen id (`claude-sonnet-5`) or its pinned alias (`sonnet5`) keeps Sonnet 5. Effort moves too: `defaultEffortForModel` returns `high`, not `xhigh`, for the bare word and every `claude-sonnet-*` id, wherever no layer sets an effort, so a frozen `claude-sonnet-5` pin with no effort moves to `high` as well. Every explicit effort pin keeps its value. `high` is Anthropic's own default for Sonnet 5.5, which recalibrated its levels against Sonnet 5, so an `xhigh` set on a 5.5 path is not the same amount of thinking as on 5. New pinned aliases: `sonnet55` / `sonnet5-5` / `sonnet-5-5`.

**Detect.** A path moves to 5.5 when its chain ends at the word `sonnet` or at the install default for the Sonnet family, and to `high` when it resolves to any `claude-sonnet-*` id and no layer sets an effort (the effort layers are listed in History: 2026-09-24, Detect). Check every layer:

```bash
# 1. Groups (model / defaultModel / providerConfig.model / providerFallback.model naming the bare word):
grep -HE '"(model|defaultModel)": *"sonnet"' groups/*/container.json
# 2. Channel wirings:
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, mga.agent_group_id, mga.default_model, mga.default_effort from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id where lower(coalesce(mga.default_model,'')) = 'sonnet'"
# 3. Task series (model_pin = sonnet). Lists pending and paused series only, so repeat it once in-flight fires have finished and before you deploy:
ncl tasks list --json | grep -B1 -A1 '"model_pin": "sonnet"'
# 4. Subagent frontmatter (group-local, then plugin agents):
grep -rHE '^model: *sonnet' groups/*/.claude/agents; find ~/plugins -type d -name agents -not -path '*/node_modules/*' -exec grep -rHE '^model: *sonnet' {} +
# 5. Session stickies: run the sticky sweep in History: 2026-09-22 (Detect §4) and look for `sonnet`.
```

A pure scheduled-task fire ignores session stickies (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts`). A group's `providerConfig.model` outranks the channel wiring (`container/agent-runner/src/providers/claude.ts`: `input.model ?? stickyConfig.model ?? NANOCLAW_CLAUDE_MODEL ?? ANTHROPIC_DEFAULT_OPUS_MODEL`), so a wiring change does nothing for a group whose `providerConfig` sets a model. The support poller's task pin rides as a one-turn flag on a message the poller dispatches only when the classifier reads that email as a light category (question, access request, follow-up, acknowledgement, automated notice) with confidence at least 0.7 and a user-facing-defect likelihood under 0.5 (`isLightTurn`, `src/modules/support-threads/dispatch.ts`); every other email, and any email with no triage, runs on the thread's normal model (the group default unless someone set a sticky `-m` in that thread). A light turn that finds engineering work hands it off with a `wait` wake, which carries no pin and so runs in the same session on the thread's normal model: the group default, or a sticky `-m` someone set in that thread. A system pin also applies only when every triggering message in the batch carries it (`applyFlagBatch`, `container/agent-runner/src/poll-loop.ts`), so a light email batched with an engineering email or a person's reply runs on the normal model. A person's reply in the support thread never inherits the pin.

**Why.** Sonnet 5.5 is Anthropic's faster, lower-cost complement to Opus 5.5 for well-scoped tasks. The container's claude-code CLI must be at least 2.1.284 to know the id: the binaries for 2.1.281, 2.1.282 and 2.1.283 contain no `claude-sonnet-5-5`, and an id the CLI does not contain silently loses its family behaviour. This change pins exactly 2.1.284, with agent SDK 0.3.284 in the same patch (`setup/lib/image-version-pins.test.ts` enforces the pair and `versions.json`).

**Fix: keep Sonnet 5 on a path, before deploying.** Pins are data and take effect without a deploy. Keeping Sonnet 5's old `xhigh` means pinning it explicitly, because it is no longer the family default:

```bash
ncl groups config update --id <group-id> --model claude-sonnet-5 --effort xhigh
ncl wirings update <wiring-id> --default-model claude-sonnet-5 --default-effort xhigh
ncl tasks update --id <series> --group <group-id> --model claude-sonnet-5 --effort xhigh
ncl tasks repin --all --from-model sonnet --to-model claude-sonnet-5 --dry-run   # bulk, MODEL ONLY: literal match, then apply without --dry-run
```

`repin` writes only the axes it is given, so the bulk command freezes the model but leaves a task that has no effort pin on whatever effort its other layers give it: the new `high` default when no other layer sets one. Run the per-series `ncl tasks update ... --effort xhigh` for every series that must keep `xhigh`.

For `providerConfig.model`, `providerFallback.model` and legacy `defaultModel`, edit `groups/<g>/container.json` directly (no `ncl` verb writes them); the edit applies at the group's next restart.

**Deploy.** Run `scripts/deploy.sh`; it rebuilds the agent image because `container/` changed. The rebuild is required: the SDK bump changes the runner's deps hash, and `src/agent-runner-image-check.ts` refuses a spawn from the base image until it matches. A group with `imageTag` in its `container.json` spawns from its own image, which a base rebuild does not touch, and an `imageTag` image with no deps label is opted out of that check, so nothing forces its rebuild: rebuild those first and confirm each CLI yourself (`grep -lE '"imageTag"' groups/*/container.json`). A host restart **adopts** running containers, which keep their spawn-time runner, CLI and `ANTHROPIC_DEFAULT_SONNET_MODEL`, so a `sonnet` pin in an adopted container still means Sonnet 5 until it exits. Recycle a group with `ncl groups restart --id <group-id>` at a quiet moment.

**Verify.**

```bash
docker inspect <fresh claude container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ANTHROPIC_DEFAULT_SONNET_MODEL
docker exec <fresh claude container> claude --version
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*) from turn_usage where ts > '<deploy time>' group by 1,2"
```

Expect `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5` and CLI 2.1.284. Unpinned groups run Opus, so the bump shows in `turn_usage` only on a turn pinned to Sonnet: `claude-sonnet-5-5` / `high` for a `sonnet` pin with no explicit effort. The env var comes from the host, so it proves the host build and says nothing about an `imageTag` image: confirm that image's CLI with `claude --version`. A container that still reads `claude-sonnet-5` was spawned before the deploy.

**Rollback.**
- **One path**: apply the Fix commands above, then `ncl groups restart --id <group-id>`.
- **The fleet default**: set `DEFAULT_SONNET_MODEL` back to `claude-sonnet-5`, set the `claude-sonnet-` branch of `defaultEffortForModel` back to `'xhigh'`, and redeploy with `scripts/deploy.sh`. The CLI/SDK pins can stay: 2.1.284 still serves Sonnet 5.

---

## History: 2026-09-24 — Opus default effort `high`

_Historical. Still in force for Opus; Fable's default effort is superseded by **2026-11-11 — Fable default effort `high`**, and the Sonnet default effort it mentions (`xhigh`) by **2026-09-29 — Sonnet default moves to 5.5** (both now `high`)._

This section was the current migration. The model does not move: `DEFAULT_OPUS_MODEL` stays `claude-opus-5-5[1m]` (see **History: 2026-09-22** below). Only the family default effort moves.

**What moves.** `defaultEffortForModel` (`container/agent-runner/src/providers/claude.ts`) returns `high`, not `medium`, for every `claude-opus-*` id, the bare `opus` alias, and a turn with no model. Fable stays `medium`, Sonnet stays `xhigh`, and Haiku stays at no effort. A path moves only when **no layer sets an effort**, because the family default is the last step of the runner's chain: `input.effort ?? stickyConfig.effort ?? NANOCLAW_EFFORT_OVERRIDE ?? defaultEffortForModel(model)` (the "Effort precedence" block in the same file). Every explicit pin keeps its value.

**Detect.** These layers pin an effort. A Claude path with none of them set moves to `high`:
- a session sticky `sticky_effort` (chat `-e`). A pure task fire ignores it (`effectiveTurnSettings`, `container/agent-runner/src/poll-loop.ts`);
- `container.json` `providerConfig.effort`;
- on a Codex-primary group, a Claude `providerFallback.effort`, which is used when that group falls back to Claude (`activeFallback?.effort`, `container/agent-runner/src/config.ts`);
- channel wiring `default_effort`, then `container.json` `effort`, then legacy `defaultEffort`. The host folds these three into `NANOCLAW_EFFORT_OVERRIDE`, in that order (`effortLayers`, `src/claude-spawn-defaults.ts`);
- a task `effort_pin`;
- a subagent's frontmatter `effort:`.

```bash
for f in groups/*/container.json; do jq -r '(if ((.provider // "claude") | ascii_downcase) == "claude" then [["effort", .effort], ["defaultEffort", .defaultEffort], ["providerConfig.effort", (.providerConfig // {}).effort]] else [] end) + (if (((.providerFallback // {}).provider // "") | ascii_downcase) == "claude" then [["providerFallback.effort (claude fallback)", .providerFallback.effort]] else [] end) | map(select(.[1] != null)) | .[] | "\(input_filename)\t\(.[0])=\(.[1])"' "$f"; done   # Claude-applicable only; a Codex group's own effort and a Codex fallback's effort are not listed
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mga.agent_group_id, mga.default_effort from messaging_group_agents mga where coalesce(mga.default_effort,'') <> ''"
ncl tasks list --json   # rows with effort_pin
grep -rHE '^effort:' groups/*/.claude/agents                                    # project scope
grep -rHE '^effort:' data/v2-sessions/*/.claude-shared/agents 2>/dev/null        # user scope (per group)
find ~/plugins -type d -name agents -not -path '*/node_modules/*' -exec grep -rHE '^effort:' {} +   # plugin-mounted roles
# Session stickies (every session's outbound.db; unreadable DBs are reported):
pnpm exec tsx -e "import Database from 'better-sqlite3'; import fs from 'fs'; for (const g of fs.readdirSync('data/v2-sessions')) { let ss = []; try { ss = fs.readdirSync('data/v2-sessions/' + g) } catch { continue } for (const s of ss) { const p = 'data/v2-sessions/' + g + '/' + s + '/outbound.db'; if (!fs.existsSync(p)) continue; try { const d = new Database(p, { readonly: true }); for (const r of d.prepare(\"select value from session_state where key = 'sticky_effort'\").all()) console.log(g, s, r.value); d.close() } catch (e) { if (!/no such table/.test(e.message)) console.error('UNREADABLE', p, e.message) } } }"
```

**Why.** Operator observation, 2026-09-24: after the 2026-09-22 move to `medium`, work reviewed by a second agent needed rework noticeably more often. That is not measured, and it is confounded: the same deploy moved Opus 5 to Opus 5.5. The cost headroom is measured. Over `turn_usage` since 2026-09-15 (human, on_wake and scheduled turns), Opus 5.5 at `medium` averaged $1.88 per turn, against $5.74 for Opus 5 at `high`, so `high` on Opus 5.5 is expected to stay below the pre-09-22 cost.

**Fix: keep `medium` on a path.** Set it explicitly before deploying:

```bash
ncl groups config update --id <group-id> --effort medium        # group
ncl wirings update <wiring-id> --default-effort medium          # one channel
ncl tasks update --id <series> --group <group-id> --effort medium
```

**Deploy.** The change is agent-runner source only. It adds no dependencies, so the image needs no rebuild. The runner source is a boot snapshot taken at host start (`src/agent-runner-source.ts`), so a **host restart** is what makes it live. Running containers are adopted across the restart and keep the snapshot they spawned with. They move as they respawn; recycle one sooner with `ncl groups restart --id <group-id>`.

**Verify.** A turn from a container spawned after the restart, for a path with no effort pin, writes `turn_usage` with `effort = 'high'` (and `effort_requested = 'high'`) on `claude-opus-5-5[1m]`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*), round(avg(cost_usd),3) from turn_usage where provider='claude' and ts > '<restart time>' group by 1,2"
```

**Success check (one week after the restart).** The rework signal was never measured directly, so judge this change on two numbers from `turn_usage`, for the coordinator group whose rework prompted the change (main-model rows only; baselines below are from the install that made this decision). Compare a 7-day window after the restart against the baselines below. The rework query counts only `high` turns, because adopted containers keep running `medium` until they respawn:

| Metric | Opus 5 / `high` (2026-09-15 → 09-22) | Opus 5.5 / `medium` (09-22 → 09-24) |
|---|---|---|
| Turns per thread that has a human turn (the rework proxy: extra agent-initiated turns per human ask) | 4.97 (79 threads; 4.72 human) | 5.66 (44 threads; 4.68 human) |
| Average cost per turn | $5.04 (623 turns) | $2.13 (255 turns) |

```bash
# rework proxy: turns per human-touched thread, and how many of them were human
pnpm exec tsx scripts/q.ts data/v2.db "with s as (select session_id, sum(trigger='human') h, count(*) n from turn_usage where agent_group_id='<group-id>' and model='claude-opus-5-5[1m]' and effort='high' and ts > '<restart>' group by 1 having h>0) select count(*), round(avg(n),2), round(avg(h),2) from s"
# cost per turn
pnpm exec tsx scripts/q.ts data/v2.db "select effort, count(*), round(avg(cost_usd),3) from turn_usage where agent_group_id='<group-id>' and model='claude-opus-5-5[1m]' and ts > '<restart>' group by 1"
```

It worked if turns per human-touched thread fall back toward 5.0, with human turns per thread flat, and cost per turn stays well under the Opus 5 / `high` baseline. If turns per thread don't fall, `high` isn't buying less rework: roll back, or look at the model switch instead. The medium-era baseline covers only about two days, so treat it as a direction, not a precise number.

**Rollback.** Change `defaultEffortForModel` back to `medium` for opus and no-model, then redeploy (host restart). No pin was written, so there is nothing to unpin.

## History: 2026-09-22 — Opus 5.5 at `medium`

_Historical. The effort half of this section (`medium`) is superseded by the section above; the model half (`claude-opus-5-5[1m]`) is current._

Everything under the older **History** further below describes the 2026-09-16 change and its values. Only that section's §1 audit script is reused here, as a tool.

**What moves.** `DEFAULT_OPUS_MODEL` (`src/flag-parser.ts`) is now `claude-opus-5-5[1m]`, and the Opus family default effort (`defaultEffortForModel`, `container/agent-runner/src/providers/claude.ts`) is now `medium`, down from `high`. On deploy, every Claude path whose model is the Opus default or an `opus` alias runs Opus 5.5. That covers primary groups, declared `providerFallback`s, `-m opus`, and `opus` task, wiring and subagent pins. Every Opus path with no effort configured runs `medium`, and that includes an explicit `claude-opus-5[1m]` pin, because the family default keys on every `claude-opus-*` id. Codex and OpenCode defaults do not move.

**Detect.** A Claude chat turn resolves its model in this order: `-m` (the turn's flag or the session sticky), then `container.json` `providerConfig.model`, then channel wiring `default_model`, then `container.json` `model`, then the install default. That is `input.model ?? stickyConfig.model ?? NANOCLAW_CLAUDE_MODEL` at `container/agent-runner/src/providers/claude.ts:1932`; the host folds wiring and group `model` into that env var. A pure scheduled-task fire resolves: task pin, `providerConfig.model`, group `model`, then the install default. It ignores session stickies (`container/agent-runner/src/poll-loop.ts:3162-3167`), and a task session has no channel wiring. Effort resolves the same way through the matching `effort` fields, then the family default. A path **moves to Opus 5.5** when that chain ends at the install default or at the word `opus`. A frozen id such as `claude-opus-5[1m]` keeps its model. A path **moves to `medium`** when it resolves to any `claude-opus-*` id and no layer sets an effort, and that includes frozen `claude-opus-5[1m]` pins. Check every layer:

```bash
# 1. Groups and every declared providerFallback, answered by the spawn resolver itself:
#    run the audit script in History §1 unchanged; "(none)" or a refusal = unpinned.
# 1b. providerConfig pins (they outrank every wiring; change them here, not on a wiring):
node -e 'const fs=require("fs");for(const g of fs.readdirSync("groups")){let c;try{c=JSON.parse(fs.readFileSync(`groups/${g}/container.json`,"utf8"))}catch{continue}const p=c.providerConfig||{};if(p.model||p.effort)console.log(g,p.model||"-",p.effort||"-")}'
# 2. Channel wirings, including effort-only ones:
pnpm exec tsx scripts/q.ts data/v2.db "select mga.id, mg.name, ag.folder, mga.default_model, mga.default_effort from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id join agent_groups ag on ag.id = mga.agent_group_id where coalesce(mga.default_model,'') <> '' or coalesce(mga.default_effort,'') <> ''"
# 3. Every live task series; "(group)" = no pin, so it follows its group's model/effort:
ncl tasks list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);for(const t of (Array.isArray(d)?d:d.data)) console.log(t.agent_group_id, t.series_id, t.model_pin||"(group)", t.effort_pin||"(group)")})'
# 4. Session stickies (every session's outbound.db, one process; unreadable DBs are reported):
pnpm exec tsx -e "import Database from 'better-sqlite3'; import fs from 'fs'; for (const g of fs.readdirSync('data/v2-sessions')) { let ss = []; try { ss = fs.readdirSync('data/v2-sessions/' + g) } catch { continue } for (const s of ss) { const p = 'data/v2-sessions/' + g + '/' + s + '/outbound.db'; if (!fs.existsSync(p)) continue; try { const d = new Database(p, { readonly: true }); for (const r of d.prepare(\"select key, value from session_state where key in ('sticky_model','sticky_effort')\").all()) console.log(g, s, r.key, r.value); d.close() } catch (e) { if (!/no such table/.test(e.message)) console.error('UNREADABLE', p, e.message) } } }"
```

A wiring with only `default_effort` keeps that effort and takes its model from the group. A sticky or pin reading `opus` moves to 5.5, and a frozen id does not.

**Why.** Opus 5.5 costs $4/$20 per MTok, against Opus 5's $5/$25, and `medium` is its API default. The container's claude-code CLI must be at least 2.1.280 to know the id, and this change pins exactly that version (with agent SDK 0.3.280 and codex-cli 0.156.0, recorded in `versions.json`).

**Fix: keep Opus 5/`high` on a path, before deploying.** Pins are data, so they take effect without a deploy:

```bash
ncl groups config update --id <group-id> --model claude-opus-5[1m] --effort high      # a whole group
ncl wirings update <wiring-id> --default-model claude-opus-5[1m] --default-effort high # one channel (no effect where providerConfig sets a value)
ncl tasks update --id <series> --group <group-id> --model claude-opus-5[1m] --effort high
```

A group whose `container.json` has `providerConfig.model`/`.effort` is governed by those values ahead of any wiring. Edit them in the file to hold or move that group. A declared `providerFallback` keeps Opus 5 only if its own `model`/`effort` in `container.json` say so.

**Deploy.** Run `scripts/deploy.sh`. It pulls, builds the host, and rebuilds the agent image, because `container/` changed. Then it restarts. The image rebuild is required: the SDK bump changes the runner's deps hash, and `src/agent-runner-image-check.ts` refuses every spawn until the image matches.

**Verify.**

```bash
docker inspect <fresh claude container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'ANTHROPIC_DEFAULT_OPUS_MODEL|NANOCLAW_CLAUDE_MODEL'
pnpm exec tsx scripts/q.ts data/v2.db "select model, effort, count(*) from turn_usage where ts > '<deploy time>' group by 1,2"
```

Expect `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5[1m]` in every Claude container, with `NANOCLAW_CLAUDE_MODEL` equal to the group's pin or to `claude-opus-5-5[1m]` when unpinned. New `turn_usage` rows for unpinned work should read `claude-opus-5-5[1m]` / `medium`. Only `ANTHROPIC_DEFAULT_OPUS_MODEL` proves the build: if it still reads `claude-opus-5[1m]`, the container was spawned from the old build or image. `NANOCLAW_CLAUDE_MODEL=claude-opus-5[1m]` on a fresh container is simply a path pinned by the Fix commands above.

**Rollback.**
- **One path**: apply the Fix commands above, then `ncl groups restart --id <group-id>`.
- **The fleet default**: set `DEFAULT_OPUS_MODEL` back to `claude-opus-5[1m]`, and set the `claude-opus-*` branch of `defaultEffortForModel` back to `'high'`. Then redeploy with `scripts/deploy.sh`, which rebuilds the image because `container/` changed. The CLI/SDK pins can stay: 2.1.280 still serves Opus 5.

---

## History: 2026-09-16 — the `opus` alias means Opus, and the fleet defaults move

_Historical. The values below (Opus 5/`high`, Codex Sol/`high`) were current on 2026-09-16. They are superseded for Claude by the section above._

Two things changed together, and only one of them is a default anyone chose.

1. **The defect.** `ANTHROPIC_DEFAULT_OPUS_MODEL` — the SDK short-circuit that decides what the bare word `opus` resolves to — carried **each group's own resolved model**, not an Opus id. So "opus" meant "whatever this group runs". When the unpinned Claude default moved to Sonnet 5 (2026-09-14, `7d0e7df3a`), the `"model": "opus"` pin that `src/group-init.ts` writes into **every** group's `.claude-shared/settings.json` started resolving to `claude-sonnet-5`. Measured in a running container: `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-5`. The alias is now the install's Opus constant in every group, and the group's model travels in its own variable, `NANOCLAW_CLAUDE_MODEL`.

2. **The defaults.** An unpinned **Claude** group now resolves to `claude-opus-5[1m]`, at Opus's unchanged `high` family effort. An unpinned **Codex** group now resolves to `gpt-5.6-sol` at `high` reasoning (was `gpt-5.6-terra` at `xhigh`) — the same tier on both providers, so a group's provider decides what runs it, not what tier it runs at.

**This changes production behaviour on deploy.** Every Claude group with no model configured moves from Sonnet 5/`xhigh` to Opus 5 [1m]/`high` on its next spawn; every Codex group with no model configured moves from Terra/`xhigh` to Sol/`high`; and every `model: opus` subagent or settings pin — in every group, including Sonnet-pinned ones — starts genuinely running Opus. **No pin is ever rewritten**, on either provider.

Pins are data (no deploy); the defaults are code (needs one). **A group you want held where it is must be pinned BEFORE you deploy**, or it runs the new default from the first spawn after the restart.

## 1. Detect

Which groups move — and it is **not** just the Claude ones. A declared `providerFallback` resolves through these same defaults, so a Codex group that falls back to Claude moves on the Claude default, and a Claude group that falls back to Codex moves on the Codex one. Measured on this install: 14 fallback paths resolve through a default that moves, and a primary-provider-only check lists none of them.

Three things make a hand-written check wrong, and all three were found in review of this PR:

- `groups/<folder>/container.json` is authoritative, not the `container_configs` row `ncl groups config get` prints (`presentConfig`, `src/cli/resources/groups.ts:68-74`) — the spawn path reads the file (`readContainerConfig`), and a DB-only update or hand edit can leave the two disagreeing.
- **A present `model` is not necessarily a pin.** `resolveClaudeSpawnDefaults` DROPS a value that is not Claude vocabulary and falls through to the default — so a `gpt-*` id left behind by `--provider claude` (which does not clear the previous provider's model), or any typo, reads as pinned and runs as unpinned.
- **The primary provider is not the only thing that runs.** See above.

So run the resolver itself, over every group and its fallback. From the install root:

```bash
cat > ./claude-default-audit.ts <<'TS'
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './src/config.js';
import { readContainerConfig } from './src/container-config.js';
import { resolveClaudeSpawnDefaults } from './src/claude-spawn-defaults.js';

// Codex's fleet defaults live in the container package (a separate Bun tree
// this host script cannot import), so read them out of their single source
// rather than restating them. Loud on a rename; never silently stale.
const codexSrc = fs.readFileSync('container/agent-runner/src/providers/codex.ts', 'utf8');
const pick = (name: string) => {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(codexSrc);
  if (!m) throw new Error(`${name} not found — read container/agent-runner/src/providers/codex.ts`);
  return m[1];
};
const CODEX_MODEL = pick('DEFAULT_CODEX_MODEL');
const CODEX_EFFORT = pick('DEFAULT_CODEX_EFFORT');

// What a spawn on `provider` resolves to, given the model/effort that reaches
// it. The claude half calls the host's own resolver; the codex half applies
// its constants the way the provider does (a pin always wins). OpenCode has
// its own default (DEFAULT_OPENCODE_MODEL, src/providers/opencode.ts) that
// this change does not touch — say so rather than running it through the
// wrong resolver.
const resolve = (provider: string, model?: string | null, effort?: string | null) => {
  if (provider === 'codex') return { model: model ?? CODEX_MODEL, effort: effort ?? CODEX_EFFORT, drops: [] as string[] };
  if (provider !== 'claude') return { model: model ?? "(this provider's own default)", effort: effort ?? undefined, drops: [] as string[] };
  return resolveClaudeSpawnDefaults({ model, effort } as never);
};

const print = (folder: string, kind: string, provider: string, configured: string | null, effort: string | null) => {
  const r = resolve(provider, configured, effort);
  console.log(
    [folder, kind, provider, configured ?? '(none)', r.model, r.effort ?? '(family default)', r.drops.join('; ') || '-'].join('\t'),
  );
};

for (const folder of fs.readdirSync(GROUPS_DIR).sort()) {
  if (!fs.existsSync(path.join(GROUPS_DIR, folder, 'container.json'))) continue;
  const cfg = readContainerConfig(folder) as Record<string, any> | undefined;
  if (!cfg) continue;
  // providerConfig is the provider's OWN sticky config, and the two providers
  // rank it oppositely: claude's `stickyConfig` beats the env the host sends
  // (claude.ts `input.model ?? this.stickyConfig.model ?? env`), while codex's
  // top-level model reaches providerConfig through config.ts and wins. Its
  // effort key differs too — `effort` on claude, `reasoning_effort` on codex.
  const provider = cfg.provider ?? 'claude';
  const pc = cfg.providerConfig ?? {};
  const [model, effort] =
    provider === 'claude'
      ? [pc.model ?? cfg.model ?? cfg.defaultModel ?? null, pc.effort ?? cfg.effort ?? cfg.defaultEffort ?? null]
      : [cfg.model ?? cfg.defaultModel ?? pc.model ?? null, cfg.effort ?? cfg.defaultEffort ?? pc.reasoning_effort ?? null];
  print(folder, 'primary', provider, model, effort);
  // A declared fallback carries its OWN model/effort and nothing else: the
  // primary's are discarded when it applies (src/provider-fallback.ts), so it
  // must be resolved from the fallback's own fields, never the group's.
  const fb = cfg.providerFallback;
  if (fb?.provider) print(folder, 'fallback', fb.provider, fb.model ?? null, fb.effort ?? null);
}
TS
pnpm exec tsx ./claude-default-audit.ts   # delete the file when you're done
```

Columns: folder, primary-or-fallback, provider, that path's own configured value, **what will actually run**, the effort, and anything the resolver refused. A path is unpinned — and moves — when its fourth column reads `(none)`, **or** when the last column names a refusal: a value the resolver threw away (a `gpt-*` id left behind by `--provider claude`, a typo) leaves the path running the default just as surely as configuring nothing. Short of that, a fifth column that merely *differs* from the fourth is usually benign: an alias expanding (`opus` → `claude-opus-5[1m]`), or an OpenCode row, which differs by construction because that provider's default is out of scope here and does not move. `(family default)` in the effort column means no effort is exported and the provider picks its own (Opus → `high`, Sonnet → `xhigh`, Haiku → none).

Run it on the code you have now to see today's answers, and again after deploy to see the new ones. It calls the same resolver the spawn path calls and reads the Codex constants out of their own source, so the vocabulary and the install defaults cannot drift from it. The one thing it restates is the per-provider ranking of `providerConfig` against the top-level fields (see the comment in the loop) — if a group ever grows a `providerConfig` block, re-read that comment before trusting the row — against `container/agent-runner/src/providers/claude.ts` for the Claude side, and against `src/container-runner.ts` (the host ships the top-level model as the channel-shaped `NANOCLAW_CODEX_MODEL_OVERRIDE`, which is why it outranks `providerConfig`) for the Codex side. `container/agent-runner/src/config.ts` alone reads the opposite way.

A per-channel wiring can also pin a model, and it outranks the group config; check any channel you care about:

```bash
ncl wirings list --json | jq -r '.data[] | select(.default_model != null) | [.id, .agent_group_id, .messaging_group_id, .default_model] | @tsv'
```

To see the defect itself in a live container before you deploy:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ANTHROPIC_DEFAULT
```

Before this change that prints the group's model in `ANTHROPIC_DEFAULT_OPUS_MODEL`; after it, `claude-opus-5[1m]` in every group, plus a separate `NANOCLAW_CLAUDE_MODEL` holding the group's model.

## 2. Why

A family alias is a promise about a word, not a per-group setting. Sharing one variable between "what `opus` means" and "what this group runs" made the two indistinguishable, so a change to either silently moved the other — which is exactly what happened: nobody decided that `model: opus` should mean Sonnet 5.

Separating them is what makes the default a decision anyone can read: `DEFAULT_OPUS_MODEL` in `src/flag-parser.ts` is what the word means, and `src/claude-spawn-defaults.ts` is what an unpinned group runs.

## 3. Fix — pin first, then deploy

For every group from §1 you want to hold where it is:

```bash
ncl groups config update --id <group-id> --model claude-sonnet-5 --effort xhigh
```

That writes the `container_configs` row **and** mirrors into `groups/<folder>/container.json`, so the pin survives the deploy and takes effect at that group's next spawn. Pin a single channel instead if only one conversation should hold:

```bash
ncl wirings update --id <wiring-id> --default-model claude-sonnet-5 --default-effort xhigh
```

Groups you want on the new default need no action.

Then deploy as usual (the runner source is a boot snapshot, so the host restart ships both halves of this change together):

```bash
sudo systemctl restart nanoclaw-v2
```

## 4. Verify

After the restart, for a container that has respawned:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'ANTHROPIC_DEFAULT_OPUS_MODEL|NANOCLAW_CLAUDE_MODEL'
```

Expect `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5[1m]` in **every** Claude group, and `NANOCLAW_CLAUDE_MODEL` equal to that group's pin (or `claude-opus-5[1m]` when unpinned).

What actually ran per turn is recorded, not inferred — the runner logs `query: model=… effort=…` per query (`docker logs <container>`), and `turn_usage` carries the resolved model and effort per turn.

## 5. Rollback

Nothing here is destructive and no data migrates, so rollback is per-group configuration or a revert:

- **One group**: `ncl groups config update --id <group-id> --model <the model it had> --effort <the effort it had>`, then restart that group (`ncl groups restart --id <group-id>`). Works the same for a Codex group (`--model gpt-5.6-terra --effort xhigh`).
- **The fleet defaults**: revert `let model = DEFAULT_OPUS_MODEL` to `DEFAULT_SONNET_MODEL` in `src/claude-spawn-defaults.ts` for Claude, and `DEFAULT_CODEX_MODEL`/`DEFAULT_CODEX_EFFORT` in `container/agent-runner/src/providers/codex.ts` for Codex, then rebuild and restart. Each provider's default is one constant; neither touches the other.
- **The alias separation is not the part to roll back.** Reverting it restores the defect: the word `opus` goes back to meaning whatever each group runs. If the fleet default is the problem, change the default.
