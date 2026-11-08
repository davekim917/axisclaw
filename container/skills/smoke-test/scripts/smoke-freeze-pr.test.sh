#!/usr/bin/env bash
# smoke-freeze-pr.sh: the walk freeze (branch, cap, PR shape) and close-walk's
# refusals. gh is stubbed via PATH and every call is logged, so each case
# asserts what reached GitHub, not only what the helper printed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/smoke-freeze-pr.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "pr list") [ "${STUB_PR_LIST_EXIT:-0}" = 0 ] && printf '%s' "${STUB_PR_LIST:-[]}"; exit "${STUB_PR_LIST_EXIT:-0}" ;;
  "pr view") printf '%s' "$STUB_PR_VIEW"; exit 0 ;;
  "pr close") exit 0 ;;
  "pr create") echo "https://github.com/org/repo/pull/77"; exit 0 ;;
esac
P="$2"
case "$P" in
  */git/ref/heads/*) exit 1 ;;
  */git/commits/*) echo tree-base ;;
  */git/blobs) cat >/dev/null; echo blob-1 ;;
  */git/trees) cat >/dev/null; echo tree-new ;;
  */git/commits) cat >> "$STUB_LOG"; printf '\n' >> "$STUB_LOG"; echo "$STUB_FREEZE_SHA" ;;
  */git/refs) cat >> "$STUB_LOG"; printf '\n' >> "$STUB_LOG"; echo refs/heads/x ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$WORK/bin/gh"

export PATH="$WORK/bin:$PATH" STUB_LOG="$WORK/gh.log"
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_PREFIX=api/ SMOKE_GATE_FRONTEND_PREFIX=web/
export STUB_FREEZE_SHA="$(printf 'f%.0s' $(seq 40))"
TARGET="$(printf 'c%.0s' $(seq 40))"
RUN=acme-floor-walk-20261104T2000Z
RUN_HASH="$(printf '%s' "$RUN" | sha256sum | cut -c1-8)"
WALK_BRANCH="smoke/walk-cccccccccccc-$RUN_HASH"
fail() { echo "smoke-freeze-pr: $*" >&2; exit 1; }
fresh() { : > "$STUB_LOG"; unset STUB_PR_LIST STUB_PR_LIST_EXIT STUB_PR_VIEW SMOKE_GATE_WALK_MAX_OPEN; }

# A walk freeze gets its own branch, a draft PR titled as a walk, and says so.
fresh
export STUB_PR_LIST='[{"number":5,"headRefName":"smoke/walk-aaaaaaaaaaaa-00000000"},{"number":6,"headRefName":"smoke/freeze-bbbbbbbbbbbb"}]'
OUT="$(bash "$HELPER" --walk "$RUN" "$TARGET")" || fail "walk freeze under the cap failed: $OUT"
jq -e --arg b "$WALK_BRANCH" --arg t "$TARGET" --arg f "$STUB_FREEZE_SHA" --arg r "$RUN" '
  . == {prNumber:77,branch:$b,freezeSha:$f,targetSha:$t,kind:"walk",runId:$r}' <<<"$OUT" >/dev/null ||
  fail "walk output: $OUT"
grep -qF "\"ref\":\"refs/heads/$WALK_BRANCH\"" "$STUB_LOG" || fail "walk branch ref not created: $(cat "$STUB_LOG")"
grep -qF "\"message\":\"smoke walk: pin develop @ cccccccccccc for QA task run $RUN\"" "$STUB_LOG" ||
  fail "walk commit message: $(cat "$STUB_LOG")"
grep -E "^pr create -R org/repo --base develop --head $WALK_BRANCH --draft --title \[smoke walk\] develop @ cccccccccccc for $RUN \(do not merge\) .* --label render-preview$" "$STUB_LOG" >/dev/null ||
  fail "walk PR create: $(grep '^pr create' "$STUB_LOG")"

# A campaign freeze is unchanged: its branch, title and output carry no walk fields.
fresh
OUT="$(bash "$HELPER" "$TARGET")" || fail "campaign freeze failed: $OUT"
jq -e '. == {prNumber:77,branch:"smoke/freeze-cccccccccccc",freezeSha:env.STUB_FREEZE_SHA,targetSha:"'"$TARGET"'"}' <<<"$OUT" >/dev/null ||
  fail "campaign freeze output changed: $OUT"
grep -q '^pr create .* --title \[smoke freeze\] develop @ cccccccccccc (do not merge) ' "$STUB_LOG" ||
  fail "campaign freeze title changed: $(grep '^pr create' "$STUB_LOG")"
! grep -q '^pr list' "$STUB_LOG" || fail "a campaign freeze counted walk PRs"

# At the cap, or when the open PRs can't be counted, nothing is written to GitHub.
fresh
export STUB_PR_LIST='[{"number":5,"headRefName":"smoke/walk-aaaaaaaaaaaa-00000000"},{"number":8,"headRefName":"smoke/walk-dddddddddddd-11111111"}]'
if OUT="$(bash "$HELPER" --walk "$RUN" "$TARGET")"; then fail "a third walk preview was cut: $OUT"; fi
jq -e '.ok == false and .openWalkPrs == [5,8] and .max == 2' <<<"$OUT" >/dev/null || fail "cap refusal: $OUT"
SMOKE_GATE_WALK_MAX_OPEN=3 bash "$HELPER" --walk "$RUN" "$TARGET" >/dev/null || fail "a raised cap still refused"
fresh
export STUB_PR_LIST_EXIT=1
if OUT="$(bash "$HELPER" --walk "$RUN" "$TARGET")"; then fail "cut a walk with the open PRs unreadable: $OUT"; fi
fresh
export STUB_PR_LIST="$(jq -cn '[range(100) | {number:(. + 1000),headRefName:"feature/x"}]')"
if OUT="$(bash "$HELPER" --walk "$RUN" "$TARGET")"; then fail "cut a walk from a truncated PR list: $OUT"; fi
for bad in "" "../run" "run id"; do
  fresh
  if OUT="$(bash "$HELPER" --walk "$bad" "$TARGET")"; then fail "accepted run id '$bad': $OUT"; fi
  [ ! -s "$STUB_LOG" ] || fail "run id '$bad' reached GitHub: $(cat "$STUB_LOG")"
done

# close-walk closes only an open draft on a walk branch, deleting the branch.
fresh
export STUB_PR_VIEW="{\"number\":77,\"state\":\"OPEN\",\"isDraft\":true,\"headRefName\":\"$WALK_BRANCH\"}"
OUT="$(bash "$HELPER" close-walk 77)" || fail "close-walk on an open walk failed: $OUT"
jq -e --arg b "$WALK_BRANCH" '. == {ok:true,pr:77,closed:true,branch:$b}' <<<"$OUT" >/dev/null || fail "close-walk output: $OUT"
grep -q '^pr close 77 -R org/repo --delete-branch ' "$STUB_LOG" || fail "close-walk did not close with the branch: $(cat "$STUB_LOG")"
while read -r view; do
  fresh
  export STUB_PR_VIEW="$view"
  if OUT="$(bash "$HELPER" close-walk 77)"; then fail "close-walk accepted $view: $OUT"; fi
  ! grep -q '^pr close' "$STUB_LOG" || fail "close-walk closed $view"
done <<'VIEWS'
{"number":77,"state":"OPEN","isDraft":true,"headRefName":"smoke/freeze-cccccccccccc"}
{"number":77,"state":"OPEN","isDraft":false,"headRefName":"smoke/walk-cccccccccccc-00000000"}
{"number":77,"state":"OPEN","isDraft":true,"headRefName":"feature/smoke/walk-x"}
VIEWS
fresh
export STUB_PR_VIEW="{\"number\":77,\"state\":\"CLOSED\",\"isDraft\":true,\"headRefName\":\"$WALK_BRANCH\"}"
OUT="$(bash "$HELPER" close-walk 77)" || fail "close-walk on a closed walk failed: $OUT"
jq -e '.ok == true and .closed == false and .state == "CLOSED"' <<<"$OUT" >/dev/null || fail "closed walk: $OUT"
! grep -q '^pr close' "$STUB_LOG" || fail "close-walk re-closed a closed PR"

echo "smoke freeze pr tests passed"
