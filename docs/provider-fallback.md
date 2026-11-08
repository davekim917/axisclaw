# Provider fallback

What happens when a group's provider account stops answering, and how it comes back.

A group declares its fallback in `container.json`:

```json
"providerFallback": { "provider": "codex", "effort": "medium" }
```

Without that declaration nothing below happens — the outage stays loud, which is
the right answer for a group that never opted in.

## The recovery ladder

A failing turn walks these in order, inside the container, and stops at the first
one that works. Each rung is a different claim about what is broken.

| Rung                   | Claim                                           | What it does                                                                                       |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Credential rotation | _this account_ is spent                         | Replays the same batch on the next OAuth slot / API key, around the whole ring                     |
| 2. Model drop          | this _model tier_ is spent, the account is fine | Replays once on the group's configured model, with the pin dropped                                 |
| 3. Provider fallback   | the provider is spent                           | Reports `provider_unavailable`; the host records a window and respawns the session on the fallback |

Rung 2 exists because a provider account's quota is not one pool. Measured
2026-09-21 22:35Z: a group pinned to `claude-fable-5-1[1m]` was rejected on
window `seven_day_overage_included` across all four OAuth slots, and the session
was rerouted to Codex — while two sibling sessions of the same agent group ran
`claude-opus-5[1m]` to completion seconds later on the ordinary `seven_day`
window. The account was never out; only the pinned tier was.

Rung 1 replays the _same_ model on every credential, so a model-scoped window
rejects the entire ring and is indistinguishable from a dead account. Rung 2 is
what tells them apart, and it needs no table of window names: it simply asks the
provider a second question.

The drop is one attempt on one credential, not a second ring pass. If the
group's own configured model is rejected too, the account really is spent and
rung 3 is correct.

**None of this is Claude-specific.** A Codex group pinned to a rate-limited
`gpt-*` model drops to its configured Codex model by the same path before
falling back to Claude.

### Codex: skipping an account that is already spent

A Codex container can only learn that an account is at its quota by starting an
app-server on it, so every fresh container used to start on the primary, read
the wall, and start a second app-server on the next account. Rung 1 now reports
the spent account to the host (`codex_account_exhausted`, with the reset the
app-server measured when it has one), and until then the host starts every Codex
container that mounts that account on the next one instead (`CODEX_START_HOME`).

The mark is keyed by the host Codex home, so groups that share an account share
the mark. It lasts until the reported reset, at most a week, or an hour when
none was reported; then containers start on the account again, until one of
them finds it still spent and renews the mark. Host-side `codex exec` runs keep
their own marks in the same shape (`codex-exec.sh`, from the usage-limit
message's "try again at" time).
It lives in host memory (`src/codex-accounts.ts`); a host restart forgets
it, which costs one extra app-server start. With every account marked, the
container starts on the primary and the ladder above runs as usual.

### Codex: a Claude or OpenCode agent's own `codex exec`

A peer agent's shells (the Claude SDK's env and the OpenCode server's env, not
the runner's own `process.env`) put the rotation shim from the skills mount
first on PATH (`container/agent-runner/src/codex-shim-path.ts`), so its
`codex exec` goes through `codex-exec.sh` like a host run: one rerun on the next
`~/.codex-fallback-N` at a usage limit, only when the refused attempt took no
action and the fallback dispatches every hook `~/.codex-runtime` does. The host
stages a peer's fallback as a bare credential, so the runner gives each one the
runtime home's config, generated guard chain and plugins under its own path
(`setupCodexFallbackRuntimes`); one it cannot build is left for the wrapper to
refuse. With no skills mount, PATH is left as it was and plain codex runs.

Rollouts accumulate in every host Codex home, and a review that is not
`--ephemeral` keeps its source bundle there, so a daily host sweep duty
(`codex-rollout-prune`, `src/codex-rollout-prune.ts`) deletes rollouts last
written over 30 days ago from each fallback home a group's account ring names.
A primary home is never pruned: it is the operator's own Codex history. A
provider=codex thread that rotated to a fallback and then sat idle past 30
days loses its rollout, so a resume starts a fresh thread.

### Claude: skipping a slot whose account is spent

A Claude container rotates its OAuth ring on a refused turn, but a fresh
container used to start on the primary even while its account sat at the
weekly wall, so every new session spent its first turn on a refusal. When a
slot is refused at an account-wide window (`five_hour` or `seven_day`; a
model-scoped window leaves the account serving other models), the runner
reports it (`claude_account_exhausted`, with the window's `resetAt`), and the
host tells later containers that forward that token which slots are marked
(`CLAUDE_SPENT_SLOTS`). A container restores its session's persisted slot
unless that slot is marked, and otherwise starts on the first slot not marked.

The mark is keyed by a hash of the token, so groups that share a token share
the mark. It lasts until the reported reset, at most a week, or an hour when
none was reported. It lives in host memory (`src/claude-accounts.ts`), and a
wrong or lost mark costs one refused turn, after which the runner rotates as
before. Each rotation posts a status row (`Claude credential rotating (…) →
slot N/M`). A retry after a refusal that came before any tool call omits the
instruction to check for side effects, since there are none.

An app-server that does not answer `initialize` within 30 seconds is replaced
once before the turn fails, because that failure reaches rung 3 and moves the
whole group to its fallback provider for 15 minutes.

An app-server that answers `initialize` but not `thread/resume` (60 seconds) is
stuck on that one saved conversation, not out of service. The runner treats it
like a thread Codex no longer knows: it drops the saved thread id, replays the
turn on a fresh Codex thread with a recap of the chat, and tells the agent its
conversation memory was reset and to catch up from the thread and its durable
notes. No `provider_unavailable` is reported. If the fresh thread fails too,
that failure walks the ladder as usual.

### What the user sees

When rung 2 succeeds, one line says so — the turn was answered by a different
model than the one pinned, and nothing else in the transcript reveals that:

> ⚙️ claude-fable-5-1[1m] is out of quota — ran this turn on the group's default
> model instead. Its window resets Sep 24, 12:00 PM. The pin is cleared; re-pin
> with `-m claude-fable-5-1[1m]` when you want it back.

A **sticky** pin is cleared, so the rest of the session stops paying that
recovery on every message. A one-off `-m` is not (there is nothing stored to
clear, and the line says nothing about re-pinning).

## Coming back

Normally: nothing. The window in `provider_health` ages out and the next spawn
returns to the primary — no cron, no probe, no operator action. Cooldowns
escalate on the failure streak (15m → 30m → 1h → … → 6h cap). Only a completed
turn clears the streak: the runner reports its first answered turn per
container (and again after any outage it reported) as `provider_turn_completed`,
and the host clears that provider's window and streak when they predate the
turn. A spawn that picks the primary clears nothing, because the primary has
not answered yet.

A container already running on the fallback does not wait for its next spawn.
A busy thread can keep one container alive for a day, long past the window, so
the host sweep restarts it once the primary has no availability window (the
`provider-fallback-return` duty, `src/modules/sweep-provider-return/`). It acts
only between turns — nothing due, no claim, no provider call and no
continuation turn in flight, re-read in the same mailbox window as the restart's
wake row. As with every sweep kill, a turn that starts in the moment between
that read and the kill is cut off; its claimed message is reset and retried on
the fresh container. It runs after provider self-heal in the same
exclusive chain, so a container self-heal restarts is not restarted twice. The
fresh container wakes on an `on_wake` row telling the agent why it was
restarted and that, back on the primary, its conversation memory does not cover
the fallback period. Only when the primary completes that turn does the thread
get one line, posted by the runner:

> ⚙️ claude is available again — this thread has moved back from codex.

A return whose first turn fails says nothing in the thread. The sweep tells a fallback container
from a primary one by the `NANOCLAW_PROVIDER_FALLBACK_APPLIED` marker in the
container's own env, so an adopted container started by an earlier host is
judged the same way.

If the primary is still failing, that turn re-records the outage and the
session goes back to the fallback. The streak keeps growing across these
returns, so an outage with no measured reset costs a busy fallback session one
restart and one failing turn after 15m, then 30m, 1h and so on up to the 6h
cap, and no thread line; a quota window with a measured reset holds the session
on the fallback until that reset.

**The operator override.** Typing `-m <a primary-provider model>` while the
session is serving from the fallback now asks for the primary back. The
container cannot route itself — the provider is chosen at spawn, from
`provider_health`, which only the host writes — so the request travels as a
`provider_retry_primary` row; the host clears that group's window, resets the
failure streak, and respawns the session.

Only a **freshly typed** `-m` does this. The same pin read out of
`session_state` on every later turn is not a request for anything, and would
otherwise hold the group in a re-probe loop for the whole window.

If the primary really is still spent, the cost is one failing turn: the outage is
re-recorded from 15m and the session goes straight back to the fallback. The
override keeps resetting the streak because it is a typed, one-off request: the
pending `-m` is claimed once, so it cannot drive a loop on its own.

## Where it lives

| Piece                               | File                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| Rungs 1–3, the chat lines           | `container/agent-runner/src/poll-loop.ts`                  |
| Answered-turn report, return line   | `container/agent-runner/src/provider-turn-completed.ts`    |
| Codex resume timeout → fresh thread | `container/agent-runner/src/providers/codex-app-server.ts` |
| Availability windows, backoff       | `src/db/provider-health.ts`                                |
| Spawn-time routing decision         | `src/provider-fallback.ts`                                 |
| Return of a live fallback session   | `src/modules/sweep-provider-return/index.ts`               |
| `provider_unavailable` handler      | `src/modules/provider-fallback/handler.ts`                 |
| `provider_retry_primary` handler    | `src/modules/provider-fallback/retry-primary.ts`           |
| `provider_turn_completed` handler   | `src/modules/provider-fallback/turn-completed.ts`          |
| `codex_account_exhausted` handler   | `src/modules/provider-fallback/codex-account.ts`           |
| Spent Codex accounts, start pick    | `src/codex-accounts.ts`                                    |
| `claude_account_exhausted` handler  | `src/modules/provider-fallback/claude-account.ts`          |
| Spent Claude accounts, start pick   | `src/claude-accounts.ts`                                   |

The three provider actions are session-scoped and act only on the reporting
session's own agent group: one records a window, the other two clear one.
`codex_account_exhausted` accepts only a Codex home mounted into the reporting
group, and its mark reaches every group that mounts the same host account.
`claude_account_exhausted` accepts only the fingerprint of a token the
reporting group still forwards, and its mark reaches every group that forwards
the same token.
