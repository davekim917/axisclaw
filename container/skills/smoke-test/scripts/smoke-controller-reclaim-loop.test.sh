#!/usr/bin/env bash
# A run whose lease lapses before its lanes start, replayed end to end on a fake
# clock: the real gate, the real renewer tick, the real live worker and the real
# controller, with gh, curl, ncl and enqueue-send faked at their transport.
#
# The timeline is one incident's, by minutes after the claim: the lease lapses
# at +19, the renewer then fails every tick, the owner's session ends at +60,
# the challenger files at +76, and the deadline stands at +90 or +120 depending
# on whether the root's delivery could be confirmed. Fires land at the gaps that
# run saw, so a lease lapses again wherever a gap passes its TTL.
#
# SMOKE_RECLAIM_SCRIPTS points the suite at another revision of this directory,
# so a reviewer can see which rows that revision fails:
#   git archive <sha> container/skills | tar -x -C /tmp/old
#   SMOKE_RECLAIM_SCRIPTS=/tmp/old/container/skills/smoke-test/scripts bash <this file>
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/smoke-case.sh"
S="${SMOKE_RECLAIM_SCRIPTS:-$SCRIPT_DIR}"
GATE="$S/smoke-pr-gate.sh"
FAKES="$SCRIPT_DIR/testdata/controller-live-fakes.py"
T="$(mktemp -d)"
[ -n "${KEEP_TMP:-}" ] && echo "keeping $T" >&2 || trap 'rm -rf "$T"' EXIT
export PYTHONDONTWRITEBYTECODE=1

unset SMOKE_CONTROLLER_MODE SMOKE_CONTROLLER_OUT_DIR SMOKE_CONTROLLER_GATE_CMD SMOKE_GATE_CLAIMANT \
  SMOKE_GATE_HOLD_FILE SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HANDOFF_LEDGER SMOKE_CONTROLLER_RENEW_CEILING_SECONDS \
  SMOKE_CONTROLLER_RENEW_FRESHNESS_SECONDS SMOKE_GATE_LEASE_TTL_SECONDS SMOKE_GATE_PROGRESS_STALE_SECONDS \
  GH_TOKEN GITHUB_TOKEN || true

fail() { echo "FAIL: $*" >&2; exit 1; }

PR=7
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
NEXT_RUN="acme-pr-pr$PR-${SHA:0:12}-20900302T000000Z"
# Far ahead of the wall clock, so a file written for real is always older than
# the renewer's freshness window and only a modelled write (`wrote`) is fresh.
T0="$(/usr/bin/date -u -d 2090-03-01T22:21:42Z +%s)"
export FAKE_NOW="$T0"

SHIM="$T/shim"
mkdir -p "$SHIM/py"
# Only "now" is faked: anything with an explicit -d or -r converts a value
# already computed against the fake now.
cat >"$SHIM/date" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in -d|--date=*|-r) exec /usr/bin/date "$@";; esac; done
exec /usr/bin/date -d "@$FAKE_NOW" "$@"
SH
# The same clock for every Python process the worker starts.
cat >"$SHIM/py/sitecustomize.py" <<'PY'
import datetime, os, time

_now = int(os.environ["FAKE_NOW"])
time.time = lambda: float(_now)


class _Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(_now, tz)


datetime.datetime = _Clock
PY
cat >"$SHIM/mountpoint" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
SH
# The gate's gh: $WORLD/prs.json is the labeled open list, and everything else
# describes an ordinary PR that settles on its listed head.
cat >"$SHIM/gh" <<'SH'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "repo "*) echo '{"name":"app"}' ;;
  "pr list") cat "$WORLD/prs.json" ;;
  "pr view") jq -c --argjson n "$3" '[.[] | select(.number == $n)][0]
    | {number, state:"OPEN", isDraft:false, headRefOid, headRefName, baseRefName:"develop",
       labels:[{name:"render-preview"}]}' "$WORLD/prs.json" ;;
  "api "*)
    case "$2" in
      *"/files?"*) echo '[{"filename":"api/src/foo.ts","status":"modified"}]' ;;
      *"/actions/runs?"*)
        sha="${2#*head_sha=}"; sha="${sha%%&*}"
        jq -cn --arg s "$sha" '[{headSha:$s,status:"completed",conclusion:"success",workflowName:"CI"}]' ;;
      *"/commits/"*) echo '{"parents":[{"sha":"pppppppp"}],"files":[{"filename":"api/src/foo.ts","status":"modified"}]}' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
SH
# A static preview: it serves whatever head the labeled list names for its PR.
cat >"$SHIM/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *%\{http_code\}*) printf 200 ;;
  *"/version"*)
    n="$*"; n="${n##*api-pr-}"; n="${n%%.*}"
    jq -c --argjson n "$n" '{sha:([.[] | select(.number == $n)][0].headRefOid)}' "$WORLD/prs.json" ;;
  *) echo '<html></html>' ;;
esac
SH
printf '#!/usr/bin/env bash\nexec python3 %q ncl "$@"\n' "$FAKES" >"$SHIM/ncl"
chmod +x "$SHIM/date" "$SHIM/mountpoint" "$SHIM/gh" "$SHIM/curl" "$SHIM/ncl"
export PATH="$SHIM:$PATH" PYTHONPATH="$SHIM/py"

export SMOKE_GATE_REPO=acme/app SMOKE_GATE_BRANCH=develop SMOKE_PREVIEW_PROVIDER=static \
  SMOKE_GATE_BACKEND_SERVICE='https://api-pr-{pr}.acme.example' SMOKE_GATE_FRONTEND_SERVICE='https://web-pr-{pr}.acme.example' \
  SMOKE_GATE_FRONTEND_PREFIX=web/ SMOKE_GATE_BACKEND_PREFIX=api/ SMOKE_GATE_MIGRATIONS_PREFIX=api/migrations/ \
  SMOKE_GATE_RUN_PREFIX=acme-pr SMOKE_CONTROLLER_SEND_TO=campaign-room

new_case() { # <name>
  C="$T/$1"
  WORLD="$C/world"
  OUT="$C/wg/controller"
  mkdir -p "$WORLD" "$C/state" "$C/wg/runs" "$C/wg/qa-coordinator/leases" "$OUT" "$C/fake"
  export WORLD
  export SMOKE_GATE_STATE_DIR="$C/state" SMOKE_GATE_RUN_ROOT="$C/wg/runs" SMOKE_GATE_SHARED_ROOT="$C/wg" \
    SMOKE_GATE_LEASE_DIR="$C/wg/qa-coordinator/leases" SMOKE_CONTROLLER_OUT_DIR="$OUT" \
    SMOKE_CONTROLLER_GATE_CMD="$GATE" SMOKE_CONTROLLER_ENV_FILE="$C/env.sh" \
    SMOKE_GATE_PUBLISH_FILE="$C/publish.json" SMOKE_GATE_HOLD_FILE="$C/hold.json" \
    SMOKE_GATE_HANDOFF_LEDGER="$C/ledger.jsonl" \
    SMOKE_CONTROLLER_OWNER_DISPATCH_CUTOVER_JSON="$C/owner-cutover.json" \
    FAKE_STATE="$C/fake" FAKE_LOG="$C/fake/calls.ndjson" FAKE_GATE_STATE="$C/state"
  : >"$FAKE_LOG"
  echo "export SMOKE_CONTROLLER_MODE='live'" >"$C/env.sh"
  jq -cn '{enabled:true,legacyRuns:[]}' >"$C/owner-cutover.json"
  jq -cn --argjson pr "$PR" --arg sha "$SHA" '[{number:$pr,headRefOid:$sha,headRefName:"feature/x"}]' >"$WORLD/prs.json"
  jq -cn --argjson pr "$PR" --arg sha "$SHA" \
    '{prs:{($pr|tostring):{state:"OPEN",headRefOid:$sha,headRefName:"feature/x"}},comments:{},issues:[]}' >"$C/fake/gh.json"
  echo '{}' >"$C/fake/settle.json"
  python3 -c 'import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT NOT NULL DEFAULT '"'"'delivered'"'"', delivered_at TEXT NOT NULL)")
c.commit()' "$C/inbound.db"
  FAKE_NOW="$T0"
  RUN="" R="" ENDED_AT="" DEADLINE_SEEN=""
}

at() { FAKE_NOW=$((T0 + $1 * 60)); }
iso() { /usr/bin/date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
state() { jq -r "$1" "$C/state/pr-$PR-state.json" 2>/dev/null; }
wrote() { touch -d "@$FAKE_NOW" "$1"; }  # a write the clock can see

deliver_all() {
  python3 - "$C/fake/enqueue.json" "$C/inbound.db" "$(iso "$FAKE_NOW")" <<'PY'
import json, sqlite3, sys
try:
    ids = json.load(open(sys.argv[1]))["messages"]
except FileNotFoundError:
    ids = {}
c = sqlite3.connect(sys.argv[2])
c.executemany("INSERT OR IGNORE INTO delivered VALUES (?, 'p1', 'delivered', ?)", [(i, sys.argv[3]) for i in ids])
c.commit()
PY
}

fire() {
  local line
  line="$(env SMOKE_CONTROLLER_LIVE_GH_CMD="python3 $FAKES gh" SMOKE_CONTROLLER_LIVE_NCL_CMD="python3 $FAKES ncl" \
    SMOKE_CONTROLLER_LIVE_ENQUEUE_CMD="python3 $FAKES enqueue" SMOKE_CONTROLLER_LIVE_INBOUND_DB="$C/inbound.db" \
    bash "$S/smoke-controller-live.sh" 2>>"$C/fire.err")"
  [ "$(jq -r '.data.failure // ""' <<<"$line")" = "" ] || fail "a fire failed closed at $(iso "$FAKE_NOW"): $line"
  deliver_all
  if [ -z "$RUN" ]; then
    RUN="$(state '.activeRunId // ""')"
    R="$C/wg/runs/$RUN"
  fi
}
renew() { bash "$S/smoke-controller-renew.sh" >"$C/renew.out" 2>>"$C/renew.err"; }
fires() { jq -s -c "$1" "$OUT/wrapper/fires.ndjson"; }
reclaims() { jq -s '[.[] | select(.kind=="run" and .slot=="claim" and .detail.reclaimed==true)] | length' "$OUT/journal.ndjson"; }

# The owner's intake, through the real scaffold while the lease is still live.
write_contract() {
  local token
  token="$(jq -r '.coordinatorOwnerToken' "$R/controller/wake.json")"
  SMOKE_LANE_ROLE=coordinator SMOKE_GATE_OWNER="$token" SMOKE_GATE_STATE_DIR="$C/state" \
    bash "$S/smoke-run-scaffold.sh" contract "$R" "$SHA" A1 B1 >/dev/null 2>>"$C/fire.err" \
    || fail "the scaffold refused the contract: $(tail -n 2 "$C/fire.err")"
  echo 'What will be tested.' >"$R/controller/root-summary.md"
}

# Stopped work that never reached a marker, as the incident left it.
first_lane_attempt() {
  mkdir -p "$R/coordinator/lanes/evidence"
  echo shot >"$R/coordinator/lanes/evidence/A1-attempt.png"
  wrote "$R/coordinator/lanes/evidence/A1-attempt.png"
}

file_disposition() { # blocked|clear|empty
  mkdir -p "$R/challenger"
  case "$1" in
    empty) : >"$R/challenger/disposition.md" ;;
    blocked)
      printf '# BLOCKED \xe2\x80\x94 campaign stopped; no certification\n\nThe lease lapsed before any lane ran.\n' \
        >"$R/challenger/disposition.md"
      jq -cn --arg sha "$SHA" '{schemaVersion:1,lane:"challenger",state:"completed",disposition:"BLOCKED",sourceSha:$sha}' \
        >"$R/challenger/challenge.complete.json"
      jq -cn --arg sha "$SHA" '{ready:false,phase:"disposition",sourceSha:$sha,missing:["coordinator/preliminary.md"],invalid:[]}' \
        >"$R/challenger/disposition-barrier.json" ;;
    clear)
      echo '# CLEAR' >"$R/challenger/disposition.md"
      jq -cn --arg sha "$SHA" '{schemaVersion:1,lane:"challenger",state:"completed",disposition:"CLEAR",sourceSha:$sha}' \
        >"$R/challenger/challenge.complete.json" ;;
  esac
}

# +0 claim, +2 the intake owner acks, +4 the last renewal that lands, then a host
# too busy to tick until the lease has lapsed at +19. Every tick after it fails
# for as long as the owner step stays inside the renewer's ceiling.
FIRES=(0 21 30 44 60 80 89 101 110 120 140 150 163 170 190 210 230 250 270)
FIRST_LATE_TICK=20
replay() { # <disposition> <owner: settles|running> [last-minute]
  local disposition="$1" owner="$2" last="${3:-270}" m=0 f=0 active
  # A controller and a renewer already in service, with nothing to claim yet.
  cp "$WORLD/prs.json" "$WORLD/prs.saved"
  echo '[]' >"$WORLD/prs.json"
  at -6; fire
  at -5; renew
  mv "$WORLD/prs.saved" "$WORLD/prs.json"
  while [ "$m" -le "$last" ]; do
    at "$m"
    [ -z "$RUN" ] || world "$m" "$disposition" "$owner"
    if [ "$m" = 4 ] || { [ "$(( m % 5 ))" = 0 ] && [ "$m" -ge "$FIRST_LATE_TICK" ]; }; then renew; fi
    if [ "$f" -lt "${#FIRES[@]}" ] && [ "${FIRES[$f]}" = "$m" ]; then
      fire
      f=$((f + 1))
      active="$(state '.activeRunId // ""')"
      if [ -n "$active" ]; then DEADLINE_SEEN="$(state '.challengerDeadline')"; fi
      if [ -n "$RUN" ] && [ -z "$active" ]; then ENDED_AT="$m"; return 0; fi
    fi
    m=$((m + 1))
  done
}

world() { # <minute> <disposition> <owner>
  local m="$1"
  case "$m" in
    2) : >"$R/controller/brief-intake.ack"; wrote "$R/controller/brief-intake.ack" ;;
    16) write_contract ;;
    29) jq -c '.intake="settled"' "$C/fake/settle.json" >"$C/s" && mv "$C/s" "$C/fake/settle.json" ;;
    31) : >"$R/controller/brief-lanes.ack"; wrote "$R/controller/brief-lanes.ack" ;;
    45) first_lane_attempt ;;
    59) [ "$3" = running ] || { jq -c '.lanes="settled"' "$C/fake/settle.json" >"$C/s" && mv "$C/s" "$C/fake/settle.json"; } ;;
    76) file_disposition "$2" ;;
  esac
  # The run tree stays written to, so the renewer keeps seeing an owner at work
  # and keeps trying: its ceiling, not its freshness window, is what stops it.
  [ ! -e "$R/coordinator/lanes" ] || wrote "$R/coordinator/lanes"/evidence/A1-attempt.png
}

# Who may still reach this PR once the run has ended.
slot_is_free() {
  local out
  out="$(bash "$GATE" claim "$NEXT_RUN" "$PR" "$SHA" owner-next 2>/dev/null)"
  jq -e --arg run "$NEXT_RUN" '.ok == true and .runId == $run and .tookOverFrom == null' <<<"$out" >/dev/null \
    || fail "$1: a new claim with no --takeover must succeed once the run ended: $out"
}

banked_nothing() {
  [ ! -e "$R/markers" ] || [ -z "$(ls -A "$R/markers")" ] || fail "$1: a marker was written for a run with no lane work"
  [ ! -e "$R/synthesis.json" ] || fail "$1: a synthesis was written for a run with no lane work"
  [ ! -e "$C/publish.json" ] || fail "$1: a BLOCKED run published a handoff: $(cat "$C/publish.json")"
  [ ! -e "$C/hold.json" ] || fail "$1: a BLOCKED run touched the promotion hold: $(cat "$C/hold.json")"
  jq -e '.verdict == "BLOCKED"' "$C/state/runs/$RUN/verdict.json" >/dev/null \
    || fail "$1: the run ends BLOCKED and nothing else: $(cat "$C/state/runs/$RUN/verdict.json" 2>/dev/null)"
}

ended_after_deadline() { # <label>
  local deadline minutes
  [ -n "$ENDED_AT" ] || fail "$1: the run never ended: at $(iso "$FAKE_NOW") it still holds PR $PR ($(state '{activeRunId,activeProgressAt,challengerDeadline}' | tr -d '\n')), reclaims $(reclaims); a rival claim answers: $(bash "$GATE" claim "$NEXT_RUN" "$PR" "$SHA" owner-next 2>/dev/null)"
  deadline="$(/usr/bin/date -u -d "$DEADLINE_SEEN" +%s)"
  minutes=$(( (deadline - T0) / 60 ))
  [ "$ENDED_AT" -ge "$minutes" ] && [ "$ENDED_AT" -le $((minutes + 45)) ] \
    || fail "$1: the run ended at +$ENDED_AT, its deadline was +$minutes"
}

no_offer_after_deadline() { # <label>
  local deadline
  deadline="$DEADLINE_SEEN"
  jq -s -e --arg d "$deadline" '[.[] | select(.kind=="owner" and .state=="enqueued" and .at > $d)] | length == 0' \
    "$OUT/journal.ndjson" >/dev/null || fail "$1: an owner step was offered past the deadline: $(jq -c 'select(.kind=="owner")|[.at,.slot,.state]' "$OUT/journal.ndjson" | tail -n 4)"
}

verdict_posted_once() { # <label> <name>
  local n
  n="$(jq --arg name "$2" '[.messages[] | select(.text | contains($name))] | length' "$C/fake/enqueue.json")"
  [ "$n" = 1 ] || fail "$1: the thread gets $2 by name exactly once, got $n: $(jq -c '[.messages[].text]' "$C/fake/enqueue.json")"
}

if smoke_case incident-filed-blocked; then
# The incident: the owner stopped, the challenger filed BLOCKED, no marker.
new_case incident
replay blocked settles
ended_after_deadline incident
[ "$(fires '[.[] | select(.pollMode == "recovery-only" and .pollTrigger == "pr_build_settled")] | length')" -ge 1 ] \
  || fail "incident: the recovery poll must reclaim the lapsed run while the renewer is failing: $(fires '[.[] | [.fire,.renewer.state,.pollMode,.pollTrigger]]')"
[ "$(state .completedRunId)" = "$RUN" ] && [ "$(state '.activeRunId // ""')" = "" ] \
  || fail "incident: the gate records the run as finished: $(cat "$C/state/pr-$PR-state.json")"
jq -s -e '[.[] | select(.kind=="gate" and .slot=="finish" and .state=="done")] | length == 1' "$OUT/journal.ndjson" >/dev/null \
  || fail "incident: finish carries it; the gate refuses challenger-timeout on a filed disposition"
banked_nothing incident
no_offer_after_deadline incident
verdict_posted_once incident no-lane-work
slot_is_free incident
fi

if smoke_case incident-empty-disposition; then
# The same loop with a zero-byte disposition: the gate counts that as not filed,
# so the existing timeout ends it, and no-lane-work is never named.
new_case empty
replay empty settles
ended_after_deadline empty
jq -s -e '[.[] | select(.kind=="gate" and .slot=="challenger-timeout" and .state=="done")] | length == 1' "$OUT/journal.ndjson" >/dev/null \
  || fail "empty: challenger-timeout carries it: $(jq -c 'select(.kind=="gate")|[.slot,.state,.detail.refusal]' "$OUT/journal.ndjson")"
banked_nothing empty
[ "$(jq '[.messages[] | select(.text | contains("no-lane-work"))] | length' "$C/fake/enqueue.json")" = 0 ] \
  || fail "empty: this ending is the challenger timeout, not no-lane-work"
slot_is_free empty
fi

if smoke_case live-first-lane-keeps-its-slot; then
# Past the same deadline with no lane finished, but the host says the lanes owner
# is still running and the challenger's disposition does not close the campaign.
new_case live-lane
FIRST_LATE_TICK=5
FIRES=(0 10 20 30 40 50 60 70 80 90 100 110 120 130 140 150 160)
replay clear running 160
[ -z "$ENDED_AT" ] || fail "live: a run with a lane in flight was ended at +$ENDED_AT"
[ "$(state .activeRunId)" = "$RUN" ] || fail "live: the run keeps its slot: $(cat "$C/state/pr-$PR-state.json")"
[ ! -e "$C/state/runs/$RUN/verdict.json" ] || fail "live: no verdict: $(cat "$C/state/runs/$RUN/verdict.json")"
[ "$(reclaims)" = 0 ] || fail "live: a stamping run is never reclaimed"
OUT_RIVAL="$(bash "$GATE" claim "$NEXT_RUN" "$PR" "$SHA" owner-rival 2>/dev/null)"
jq -e --arg run "$RUN" '.ok == false and .activeRunId == $run and (.error | test("another run already owns"))' <<<"$OUT_RIVAL" >/dev/null \
  || fail "live: a rival claim is refused while the run stamps: $OUT_RIVAL"
# Only a human's `claim --takeover` displaces a live run: poll has no use for it.
TOKEN="$(state .activeLeaseOwner)"
bash "$GATE" poll --recovery-only --takeover >/dev/null
bash "$GATE" poll --takeover >/dev/null
[ "$(state .activeRunId)" = "$RUN" ] && [ "$(state .activeLeaseOwner)" = "$TOKEN" ] \
  || fail "live: a poll took the slot: $(cat "$C/state/pr-$PR-state.json")"
fi

if smoke_case recovery-only-poll; then
# Every claim a poll could make, with --recovery-only on and off.
new_case recovery-only
POLL="$(bash "$GATE" poll --recovery-only)"
jq -e '.wakeAgent == false' <<<"$POLL" >/dev/null || fail "recovery-only: a fresh PR is not claimed: $POLL"
[ "$(state '.activeRunId // ""')" = "" ] || fail "recovery-only: it opened a campaign: $(cat "$C/state/pr-$PR-state.json")"
POLL="$(bash "$GATE" poll)"
jq -e '.data.trigger == "pr_build_settled" and .data.resumedRunId == false' <<<"$POLL" >/dev/null \
  || fail "recovery-only: positive control: the same PR is claimed without the flag: $POLL"
RUN="$(state .activeRunId)"
TOKEN="$(jq -r .data.coordinatorOwnerToken <<<"$POLL")"

# Quiet past the staleness window, a moved head is a new campaign: no mint.
at 40
jq -c '.[0].headRefOid="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$WORLD/prs.json" >"$C/p" && mv "$C/p" "$WORLD/prs.json"
POLL="$(bash "$GATE" poll --recovery-only)"
jq -e '.data.trigger != "pr_build_settled"' <<<"$POLL" >/dev/null || fail "recovery-only: a moved head was claimed: $POLL"
[ "$(state .activeRunId)" = "$RUN" ] || fail "recovery-only: the slot moved: $(cat "$C/state/pr-$PR-state.json")"

# The same head and a lapsed lease: the run comes back under its own id.
jq -c --arg sha "$SHA" '.[0].headRefOid=$sha' "$WORLD/prs.json" >"$C/p" && mv "$C/p" "$WORLD/prs.json"
POLL="$(bash "$GATE" poll --recovery-only)"
jq -e --arg run "$RUN" --arg old "$TOKEN" '.data.trigger == "pr_build_settled" and .data.runId == $run
  and .data.resumedRunId == true and .data.coordinatorOwnerToken != $old' <<<"$POLL" >/dev/null \
  || fail "recovery-only: a stale run on its own head is recovered: $POLL"

# A lower-numbered fresh PR does not starve the recovery of a higher one.
at 80
jq -c '[{number:3,headRefOid:"cccccccccccccccccccccccccccccccccccccccc",headRefName:"feature/y"}] + .' "$WORLD/prs.json" >"$C/p" && mv "$C/p" "$WORLD/prs.json"
POLL="$(bash "$GATE" poll --recovery-only)"
jq -e --argjson pr "$PR" '.data.pr == $pr and .data.resumedRunId == true' <<<"$POLL" >/dev/null \
  || fail "recovery-only: the recoverable PR must win over a fresh lower one: $POLL"
[ ! -e "$C/state/pr-3-state.json" ] || [ "$(jq -r '.activeRunId // ""' "$C/state/pr-3-state.json")" = "" ] \
  || fail "recovery-only: the fresh PR was claimed"

# Only `poll` takes it: a stray flag on `claim` must not read as a plain claim.
OUT_CLAIM="$(bash "$GATE" claim "acme-pr-pr3-cccccccccccc-20900302T000000Z" 3 cccccccccccccccccccccccccccccccccccccccc owner-x --recovery-only 2>/dev/null)"; RC=$?
[ "$RC" = 2 ] && jq -e '.ok == false and (.error | test("only to poll"))' <<<"$OUT_CLAIM" >/dev/null \
  || fail "recovery-only: claim refuses the flag: rc=$RC $OUT_CLAIM"
fi

smoke_cases_done
echo "smoke-controller-reclaim-loop: ok"
