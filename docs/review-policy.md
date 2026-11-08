# Review policy

The fleet's review severity contract: what a review finding is for, what
blocks a merge, and what reviewers should not report. One definition —
skills and prompts point here instead of restating it.

## What this file binds — and what it cannot

Binds:

- Triage of incoming review findings (`pr-review-loop`, host and container
  copies).
- Any review prompt this fleet composes itself: the bootstrap cross-model
  review step, `/code-review` invocations, ad-hoc reviewer briefs.
- Workgroup triage: workgroup runbooks cite this file and may extend it with
  binding rulings of their own.

Does NOT bind: `chatgpt-codex-connector[bot]`. Its PR auto-review prompt is
OpenAI's, not ours. The bot reporting a nit outside this policy is expected,
not a violation — this policy governs how such findings are triaged, not
what the bot says.

## Review availability

A valid review is evidence; a silent or unavailable provider is not. A
connector's thumbs-up or "no major issues" comment is the same kind of silence:
it shows Codex did not object, not what it read. A `review`-verdict head needs a
written review on that head, either a Codex review carrying a finding or a
substitute receipt, and `merge-check` refuses without one (`review_not_written`).
When the
authenticated GitHub Codex connector reports its code-review usage limit for
the current head, or its bounded foreground wait expires, immediately use an
already accepted independent review route. Do not wait for a human quota reset
or seek new permission just to select that route.

The substitute reviewer starts in a fresh context and receives the final SHA,
complete diff, relevant files, this policy, and every existing finding. Prefer
another capable agent or provider. Implementation reasoning cannot approve its
own change. A substitute review still triages findings under this policy and
does not relax required CI, holds, or merge authorization.

The substitute, like every review (a delta check after a rebase or ratchet
regeneration, adversarial verification, a gap analysis), runs on a frontier
model at `high` effort. There is no list of approved models, because vendors
ship new frontier models faster than a list can be edited. Routine reviews
default to **Opus on Claude** (`--model opus`, or a subagent's `opus` alias) and
**`gpt-6.1-sol` on Codex** (`codex exec -m gpt-6.1-sol`, passed explicitly
because an alternate `CODEX_HOME` may configure no model); `opencode run` uses
its configured model unless given `-m`. `gpt-6-astra` and Fable review only
when a human explicitly asks for that model in the request — never by default,
by inheritance, or because the dispatching session runs on one — and a receipt
naming either cites that request (who, when, and a link or message id). Effort is a runtime setting — a native spawn's own field, or
a scoped CLI invocation — never prompt wording. `opencode run` has no effort
flag at all (effort is per-model `options` in the opencode config,
`container/agent-runner/src/providers/opencode.ts:535-536`), so on that pool
the model id is the whole tier.

Eligibility is enforced as a **denylist of small tiers**:
`REVIEWER_DENIED_TIERS` in `container/skills/pr-review-loop/scripts/codex-review.sh`
(`sonnet haiku luna terra mini nano lite small`). `codex-review.sh receipt` and
`merge-check` read only `--reviewer`'s **first whitespace-delimited word**; they
lowercase it and strip a trailing `[1m]` and any provider path (`opencode/`,
`opencode-go/`). What is left must be a concrete versioned id, not an alias. It
is refused if any whole `-`/`.`/`_` segment is a denied tier. Segments, not
substrings: `gpt-5.4-mini` is refused, `gemini-3.8-flash` is not. `flash` is
not denied — it is a latency brand that spans tiers (DeepSeek v4.1-flash and
Gemini 3.8-flash are frontier-class; `gemini-3.5-flash-lite` is refused for
`lite`). **The trade-off:** a denylist fails open, so a new small model whose
name carries none of those words passes until it is added.

The reviewer reports its **exact model id from its own runtime** — a Claude
subagent from its system prompt, Codex from the `-m` it ran with or
`codex exec`'s session metadata, OpenCode from `-m` — as that first word, and
the receipt's `--reviewer` copies it verbatim, e.g. `claude-opus-5 (opus)`,
`gpt-6.1-sol high (codex exec)` or `opencode/deepseek-v4.1-flash (opencode run)`.
Everything after the first word is free text. Nobody has to be free for this:
the author may start that reviewer as a fresh process
(`container/skills/pr-review-loop/scripts/codex-exec.sh -m gpt-6.1-sol -c model_reasoning_effort=high`,
which moves to the next Codex account once on a usage limit,
`claude -p --model opus --effort high --safe-mode --no-session-persistence
--permission-mode plan --tools '' --strict-mcp-config --output-format json < prompt`,
or `opencode run -m <provider/model> '<prompt>' < /dev/null`) and hand it the
inputs above. Keep the `claude -p` flags exactly as written: in a Claude-provider
container signed in with an OAuth token only that tool-less form reaches the
runner's credentials, and any other flag set fails with "Not logged in" (see
[agent-runner-details.md](agent-runner-details.md)). With no tools, the prompt
must carry the diff and the files.

Record a durable review receipt tied to the exact final SHA: reviewer and
runtime, complete-diff and relevant-file scope, outcome, and every finding with
its disposition. A local completion claim is not substitute-review coverage.

A repo whose rules forbid naming an AI model in a PR comment sets
`"neutralReviewerLabel": true` in its base branch's `.github/pr-review-loop.json`,
or, where the repo should carry no such file, the install names it in
`CODEX_REVIEW_NEUTRAL_REVIEWER_REPOS`: comma-separated `owner/repo`, matched
case-insensitively and exactly, e.g. `ExampleOrg/web,ExampleOrg/data`. Set it
in the install's `.env`: the host forwards it to every agent container it spawns
(Claude, Codex and OpenCode alike; not the wiki-maintenance runtime), so a change reaches a container at its first
spawn after a host restart, and at boot a malformed entry is logged at WARN and
DMed to the owner while the list is still forwarded as written. A listed
repo skips the file read. An entry that is not `owner/repo` matches nothing,
and while one is present `receipt` refuses (exit 1, nothing posted) any repo
that neither the list nor the file opts in, since the bad entry may have meant
it. `codex-review.sh receipt` then still takes `--reviewer` with the model id and
still refuses a small tier, but the posted comment's reviewer line reads
`independent review`, and the id goes to the receipt ledger instead: one file
per posted comment, `<ledger>/<owner>/<repo>/<pr>/<comment id>.json`. The
ledger is one directory: what `CODEX_REVIEW_RECEIPT_LEDGER` names, else an
agent container's group folder (`/workspace/agent/review-receipts`, the host's
`groups/<folder>/review-receipts/`), else the install's `data/review-receipts/`
on the host. It is never a scan of other groups' folders: an entry is a
reviewer claim, and a group with no write access to the repo must not be able
to lend one to another group's receipt. The comment must not name the id
anywhere else either; `receipt` refuses a body or claim that does, and the
reviewer's report is the author's to keep clean beyond that. `merge-check`
resolves the label through the ledger before the tier rule, so a labelled
receipt with no entry for its comment — posted by hand, from another group or
install, or into a ledger the merge does not read — is `receipt_unresolved`
and unlocks nothing: post it again where the merge runs, or run the merge with
`CODEX_REVIEW_RECEIPT_LEDGER` naming the ledger that holds it (on the host,
`groups/<folder>/review-receipts` for a receipt that group's container posted). `audit` reads the
same way, so the gate-audit job, which runs from a fresh checkout with no
ledger, flags every merge on such a receipt: a repo that runs that job does
not opt in. A repo with neither the flag nor a list entry is unchanged: the id stays in the comment,
and a hand-written `independent review` line there resolves nowhere.

## Changing who may review

There is no longer a worker-policy file, in this repo or in the bootstrap
plugin. The plugin ships delegation as effort shims that inherit the caller's
model, so nothing in a live config names a concrete frontier model any more,
and nothing can be derived from one. Two settings govern review, and they
are independent of each other:

- **Who may review.** Any frontier model; nothing to edit when a new one
  ships. Eligibility is not dispatch: routine reviews still run on the Opus /
  `gpt-6.1-sol` defaults above, and `gpt-6-astra` or Fable only on an explicit
  human request. Only the small-tier denylist, `REVIEWER_DENIED_TIERS` in
  `container/skills/pr-review-loop/scripts/codex-review.sh`, changes — add a
  word when a vendor names a new small tier.
- **What a Codex subagent runs at.** Codex's native default: the generated
  container config (written identically by `src/providers/codex.ts` and
  `container/agent-runner/src/codex-companion-setup.ts`) sets no
  `[agents].default_subagent_reasoning_effort`, matching the operator's host
  config. A native spawn's own `reasoning_effort`, or a role's
  `model_reasoning_effort`, sets it per task.
  `src/providers/codex.container-config.test.ts` and
  `container/agent-runner/src/codex-companion-setup.test.ts` assert the
  rendered line verbatim — deliberately literals, not a shared constant read
  back, since an oracle reading the same constant as the code can never
  disagree with it (the recurring `mutation coverage` lesson in
  `docs/review-notes.md`). `src/provider-surfaces.test.ts` proves the host and
  container renders agree.

Adding a word to `REVIEWER_DENIED_TIERS` costs every model it matches receipt
eligibility immediately, including on heads already receipted, because
merge-check re-reads the receipt against the current rule. Add a tier word only
for a genuinely small tier.

**Which reviewer is dispatched** follows the defaults above — Opus or
`gpt-6.1-sol` routinely, `gpt-6-astra` or Fable only on an explicit human
request; within those, a reviewer is chosen for independence from the
artifact's author, not for a worker tier.

Containers read the generated config at spawn, so an effort change reaches a
running agent only when its container restarts on the new image.

## Review notes and fix links

Before writing or reviewing code, the author and the reviewer read
`docs/review-notes.md` and every `docs/review-notes/<PR>.md` fragment.

Every review verdict this fleet produces is posted as a receipt
(`codex-review.sh receipt`), `changes` included: a verdict that stays in chat
leaves nothing for the gate or the notes to read. A PR that received any
`changes` receipt, on any head, adds its own
`docs/review-notes/<that PR number>.md` fragment in the same PR, or carries a
body line `Review-notes: none (<reason>)` with a non-empty reason. The
fragment holds one or more lesson lines in the format and classes that
`docs/review-notes.md` registers; it never appends the shared historical file.
A finding fixed during review is a lesson as much as a deferred one, and it is
the kind that used to go unrecorded.
`codex-review.sh merge-check` refuses without one (exit 24,
`review_notes_missing`), and `audit` re-checks it as of the merge. A line
inside a code fence or an HTML comment doesn't count, and the reason is one
parenthesised phrase, nothing after it on the line, with at least one visible
character. Zero-width space, soft hyphen, zero-width joiner, and other Unicode
format characters are allowed inside an otherwise-visible reason; a reason
left with nothing but those, whitespace, control characters, bare combining
marks, or a handful of blank-looking codepoints (U+2800, U+3164, U+115F,
U+1160, U+FFA0) once they're stripped is refused. Deferring a finding to an
issue, or reverting a PR, adds a line too.

When this rule, or any merge-check rule, changes on main, re-extract the gate
before the next merge. A PR merged through a skill copy extracted before the
change landed, but merged after it, is audited under the rule its merge
commit carries — each merge is audited with its own commit's copy of the
skill (the CI job's `gate-audit.sh`) — and can be flagged
`gate-bypass`. No go-live cutoff is needed.

A class on a second aggregate line must name a structural fix on its newest
line: the lint rule, test or primitive that now catches it.
`scripts/review-notes.test.ts` fails the PR that records the second occurrence
without one, which is where that fix belongs.

When the PR carries `risk:*` dimension labels, they scope the reviewer's
brief. Labels are for reading: `codex-review.sh scope` decides whether a head
is reviewed at all from the PR's changed files, and a label can only add
review, never remove it.

Every `fix` PR carries `Fixes-PR: #<n>`, naming the PR it fixes, or
`Fixes-PR: none` in its body; `codex-review.sh merge-check` enforces it. A
line inside a code fence or an HTML comment doesn't count.

In a repo whose base branch sets `"requireReplacesLine": true` in
`.github/pr-review-loop.json`, every PR body also carries `Replaces:` followed
by what the change supersedes, or `Replaces: nothing`. merge-check reads it
from the body at merge time, the same way, and the reviewer verifies the
claim: the replaced code is gone in the same PR.

Every repo also answers to the comment rule at merge: merge-check runs the
shared `comment-rule` checker from the bootstrap plugin over the change from
its merge base, and refuses a head that adds a prohibited comment form (a
file:line or PR/ticket citation). It is on by default; a repo opts out only
with `"commentRule": false` in the base branch's
`.github/pr-review-loop.json`, and a checker that cannot run refuses rather
than passes. Comment growth is not refused. The reviewer judges each comment
the diff adds: it stays only when a reader, human or agent, would get
something wrong without it (an external system's quirk, why the obvious
approach is wrong); anything else is a finding to cut.

In a repo whose default branch sets `"publicBoundaryScan": true` in
`.github/pr-review-loop.json`, merge-check also runs the install's
`scripts/check-public-boundary.ts` over exactly the head it is asked to merge
(its tree, as the pre-push hook scans a pushed commit) and over the squash
commit message the merge would publish: the PR title with ` (#<n>)`, then its
body. A private identifier refuses the merge (exit 24); the fix is a fictional
value in a new head, or an edited title or body. The scan's exemptions, the
baseline and allowlist, are read from the default branch, never the head, so a
PR's own entry never exempts its own hit; a PR that adds an exemption for a
name it publishes cannot pass the gate and is reviewed and merged by hand. The
default branch decides for every PR, whatever its base: GitHub merges a PR into
the base it has at merge time, so a PR retargeted after the check would
otherwise skip the scan.

In such a repo `codex-review.sh merge` always squash-merges, with exactly the
subject and body it scanned. A merge commit would carry every intermediate
commit's tree and message into the base, and GitHub's default message would
re-read a title edited after the scan. A base that requires a merge queue is
refused before anything is queued, since a queued merge ignores the method,
subject and body; such a PR is merged by hand.

The scan needs the install's registry and identifier inventory, which only the
host has: merge-check run where they are missing (an agent container, a scratch
extraction without `NANOCLAW_DIR` naming the install) gives no verdict rather
than passing. `audit` does not re-run it, since a GitHub runner has no
identifier list; the host's daily scan of main (`scripts/check-remote-boundary.ts`)
catches a merge that went around the gate.

## The test is blocking, not correctness

Most findings should not stop a merge, including real ones. Review exists to
catch what is glaringly destructive; quality comes from the whole gauntlet —
automated review, QA, humans using the thing.

- **Blocks — destructive.** Data loss or corruption; money computed, moved,
  or reported wrong; tenant or scope isolation breached; auth or permission
  bypassed; credentials exposed; a migration whose undo does not exist.
  Blocks at any round; no deadline lowers the bar.
- **Does not block — record it and merge.** Everything else, including real
  defects that are narrow, cosmetic, adjacent, pre-existing, or hardening
  niceties. Record the finding wherever the deployment collects them, link
  it from the thread, resolve the thread, merge.
- **Exception — a finding that contradicts a claim in the PR body never
  merely gets recorded, at any severity.** Fix the code or fix the body.
  Pasted test output is a claim. Correcting the body is usually the right
  branch — it costs no push, so review coverage at head stands, and the
  finding stays recorded.

State the classification in one line in the thread. An unnamed call cannot
be overruled, and a human overruling you is the point.

Every finding deferred (recorded instead of fixed) carries its reason and a
re-raise trigger — a deferral with no trigger is a finding that quietly
disappears.

## Escalation is severity direction, not round count

There is no round number that forbids a push. A high round count with
severity falling is convergence; severity flat or rising across rounds means
stop and diagnose out loud before touching code.

A class that survives three rounds is a design defect at a seam, and the fix
is the primitive, not the next call site: the loop refuses site patches until
it lands. A finding class is the invariant a finding cites plus the seam its
flagged sites share, so one missing guard reported at four call sites is one
class with four rounds, not four files with one round each — the shape a
file-level detector cannot see, and the shape that has run a single PR to
fourteen rounds. `pr-review-loop`'s gate (`codex-review.sh gate`, run by
`codex-review.sh push`) makes this deterministic: three rounds on one class, or
on one seam with severity not falling, exits non-zero naming the class, the
sites and the candidate primitive, and lifts only on a commit that touches that
primitive or carries `Reframe: <invariant> enforced in <primitive>`. A class
whose seam the classifier cannot substantiate — no shared import, or a single
flagged file whose findings name nothing that module exports — gates on its
place (its files' directory, two components deep) and lifts only on that
trailer, since naming a guessed primitive would leave the override as the only
way out. Substitute and independent receipts that ask for changes count as
rounds; the Codex round cap does not count them. The reframe trailer may name
any primitive the commit itself introduces, not only the classifier's
candidates. `REVIEW_LOOP_ALLOW_SITE_PATCH=1` overrides the gate loudly and
records the override in the PR body. Agent containers get the same gate at
their own push primitive — the `git_push` tool runs it before pushing — so the
rule does not depend on which surface is working the loop.

## Fix discipline

Accepting a finding authorizes the finding, not any fix. Two rules bind
whoever writes the fix — a review loop, an auto-fix pass, a worker:

- **Scope expansion escalates to a human.** If the honest fix adds machinery
  (a new helper layer, flag, wrapper, config), a new dependency, or edits
  outside the diff's existing footprint, it leaves the batch: post the
  finding with the fix you would make and let a human route it onto this PR
  or its own. Measured over 20 consecutive merged PRs: 94% of later-round
  findings landed on code fix commits had touched — the fixes, not the
  original diffs, were generating the rounds.
- **Simplification over machinery.** Prefer the fix that subtracts: tighten
  an existing guard, hoist the check to the seam every caller shares, delete
  the path the finding lives on. If no simplifying fix exists, that is a
  design signal — escalate it, don't build around it.

## Workarounds where the design should change

A diff that adds an adapter, flag, caller-side re-check, special case or
second helper where the owning code should change instead is a candidate
finding. To raise it, the reviewer substantiates the avoidable complexity or
failure, names the owning primitive, and says why changing it is safer than
the workaround. Taste alone is never a finding, and hypothetical
extensibility earns no credit. A containment or compatibility workaround is
legitimate when the PR says why. Severity follows the contract above: it
blocks only when destructive.

These shapes are prompts to investigate, not defects in themselves: one
invariant owned in two places; two ways to do one job; a pass-through layer
that adds no policy; a shallow module whose interface is as large as what it
hides; a list kept in sync by hand; internals a caller can import; a format
or assumption two modules must both know; code split by when it runs rather
than by what it owns.

On any PR, fix or feature, a timer that waits for a completion something
already signals is one of these shapes: a poll, a cron or scheduled task, a
sleep-and-check or retry-until-done loop, where the producer emits, or could
be made to emit, an event, callback, webhook, status or message the consumer
could be driven by. The owning primitive the finding names is that signal,
or the producer to change. A timer whose job is time itself (a daily report,
a TTL, a reconcile that catches out-of-band changes no event covers) is not
a finding when the PR states that reason. Like the rest of this class, the
finding stays below P1 and blocks only when the timer is destructive.

On any PR, fix or feature, a new warehouse, compute pool or runner for one
job where an existing one fits is one of these shapes, a second system. The
finding names the existing one. A new one is not a finding when the PR
states a reason the existing one cannot serve: a different cost owner to
isolate, a size it cannot take, or a security boundary.

Some always resolve to a check, never a note. A list kept in sync by hand
gets a test that derives one from the other or fails when they disagree;
importable internals get an import restriction that fails the build; a
constraint stated in a comment is encoded as a type, test, assert or lint
rule, and the comment goes.

On a `risk:high` PR — one whose changed files match a `risk:high` glob in
`.github/labeler.yml`, the list `codex-review.sh scope` reads — the reviewer
also walks one plausible next change, grounded in the touched code's
history: where would it go, how many places must agree, and what would catch
the mistake.

An author may justify a shape with an optional PR-body line,
`Design: <what fought the change>; <fixed here | worked around because <reason>>; owning primitive <name>[; follow-up #<n>]`.
Like the churn gate's `Reframe:` trailer it names the primitive; unlike
`Fixes-PR:` or `Replaces:`, nothing requires it, and a PR with nothing to
justify omits it. A workaround shape with no justification is a finding;
with one, it is a claim to verify, so a finding that contradicts it falls
under the PR-body exception above.

A stewardship PR — one whose purpose is a behaviour-preserving
simplification — pins the behaviour before moving structure: a
characterization, snapshot or equivalence test that fails if behaviour
changes. Typecheck and lint pass on changed behaviour, so they are not a
pin. It weakens no assertion, case or fixture, and if the diff does not
reduce what a reader must hold to change that code, it is reverted, not
merged.

## Bolted-on features

On a feature PR (`feat:`), not a fix, the reviewer asks one question: would
this code look like this if the feature had been in the original design? A
feature added beside the design rather than into it is a candidate finding
under the workaround class above, with the same burden and severity. Shapes
to look for:

- a special-case `if (newKind)` branch in code that already dispatches on
  kind;
- a flag or boolean duplicating what a type or discriminant already encodes;
- a near-copy of a file, component or function for one variant;
- an alias or local re-deriving a value the code already has;
- a second system beside an existing one: logger, counter, retry, config
  reader, tracker;
- a test that only pins the workaround: it asserts the bolted-on path
  stays separate, not a behaviour a fold-in must keep (that pin is the
  stewardship rule above, and it stays).

Each finding names the existing helper, type or system the feature folds
into; one that cannot name it is taste, not a finding. A fold-in that
changes an existing test states the contract change it makes; one that only
weakens a test to pass is rejected. The check reads repository code (the
existing system usually lives outside the diff), never production data.

## Reporting shape

For reviewers whose prompt we compose (the bot's is OpenAI's — see above):
for any race, TOCTOU, or ownership finding, report the CLASS once — enumerate
every site in the PR that has it in one pass, and name the primitive where the
invariant belongs. Do not report the same class at one site per round. One
site per round is what turns a single missing guard into a fourteen-round PR,
and it is the reviewer half of the escalation rule above.

## Do not report

For reviewers (where we control the prompt) and triagers alike:

- Generated files, lockfiles, and vendored mirrors — they have their own
  drift gates.
- Anything a deterministic gate already enforces: formatter, linter,
  boundary check, parity/conformance/drift tests, required CI checks.
- Pre-existing defects outside the diff — record them in the deployment's
  log, never as PR findings.
- Rate-limit warnings and transient provider errors — the fleet has key
  rotation and fallback; these are never findings and never escalate.
- Style preferences no formatter enforces.

## Workgroup extensions

A workgroup runbook may refine this policy with binding rulings of its own
(for example, a reachability gate on which destructive findings block in
that deployment). The PR-body-contradiction exception outranks any such
refinement.
