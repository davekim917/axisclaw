#!/usr/bin/env bash
# Cut a "freeze PR" — an on-demand frozen preview environment for an
# arbitrary develop SHA, for smoke-pr-gate.sh to poll like any other labeled
# PR. See groups/_ops/specs/fleet-hardening/phase5-preview-envs.md ("Freeze
# PRs") for the verified mechanics this implements:
#
#   - An EMPTY commit on a branch produces zero previews (verified live,
#     PR #759: 35 minutes, zero preview events). Render only builds a preview
#     when the PR diff touches the service's rootDir, so this script instead
#     adds ONE marker commit creating `.render-freeze` (containing the target
#     SHA) under each service's root dir (the *_PREFIX env) — build-inert (nothing
#     imports a dotfile), but a real diff.
#   - Draft PRs DO trigger previews (verified live, PR #775: draft from
#     creation, labeled at creation, both previews within 30s). Draft is also
#     the right shape independent of that fact: a placeholder that can't be
#     merged by accident and never enters review lanes.
#   - The marker commit is built via the git data API (blobs/trees/commits/
#     refs) rather than a local checkout, so this script needs nothing but
#     `gh` and network — no worktree, no clone.
#
# Usage: smoke-freeze-pr.sh <target-sha>
#        smoke-freeze-pr.sh --walk <run-id> <target-sha>
#        smoke-freeze-pr.sh close-walk <pr>
#   <target-sha>  full 40-character SHA on SMOKE_GATE_BRANCH to freeze.
#   --walk        a preview for ONE task-scoped run (smoke-pr-gate.sh task-claim),
#                 on branch smoke/walk-<sha12>-<8 hex of the run id>. smoke-pr-gate.sh
#                 poll never campaigns on a walk PR, and closes one left open past
#                 SMOKE_GATE_WALK_MAX_SECONDS. Refused while SMOKE_GATE_WALK_MAX_OPEN
#                 walk PRs are already open.
#   close-walk    closes a walk PR and deletes its branch; refuses any PR that is not
#                 a draft on a smoke/walk- branch. An already-closed walk PR is ok.
#
# Env (same family as smoke-pr-gate.sh):
#   SMOKE_GATE_REPO             required, "owner/repo".
#   SMOKE_GATE_BACKEND_PREFIX / SMOKE_GATE_FRONTEND_PREFIX
#                               required to cut, each service's root dir with a trailing "/".
#   SMOKE_GATE_BRANCH           base branch for the draft PR (default: develop).
#   SMOKE_GATE_LABEL            opts the PR into Render previews (default: render-preview); must exist.
#   SMOKE_GATE_WALK_MAX_OPEN    open walk PRs allowed at once (default 2).
#
# Output: one JSON line on success —
#   {"prNumber":<n>,"branch":"smoke/freeze-<sha12>","freezeSha":"<40char>","targetSha":"<40char>"}
#   (a walk adds "kind":"walk","runId":"<run-id>"; close-walk prints {"ok":true,"pr":<n>,"closed":<bool>,...})
# or {"ok":false,"error":"..."} (plus whatever partial state was created, so
# a failure after the branch exists can be cleaned up or retried by hand —
# this script does not force-push or roll back a partial freeze).
#
# Teardown: Render auto-deletes the preview services on PR close (verified).
# Closing a campaign freeze PR is the caller's job; a walk PR is closed by
# close-walk, or by smoke-pr-gate.sh poll once it outlives its cap.
set -u

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,/^set -u$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

REPO="${SMOKE_GATE_REPO:-}"
BRANCH="${SMOKE_GATE_BRANCH:-develop}"
LABEL="${SMOKE_GATE_LABEL:-render-preview}"
WALK_PREFIX="smoke/walk-"

if [ "${1:-}" = "close-walk" ]; then
  PR="${2:-}"
  if [ -z "$REPO" ] || ! printf '%s' "$PR" | grep -Eq '^[1-9][0-9]*$'; then
    jq -cn '{ok:false,error:"usage: smoke-freeze-pr.sh close-walk <pr> (SMOKE_GATE_REPO required)"}'
    exit 2
  fi
  if ! VIEW="$(timeout 10 gh pr view "$PR" -R "$REPO" --json number,state,isDraft,headRefName 2>/dev/null)" ||
     ! jq -e 'type == "object"' <<<"$VIEW" >/dev/null 2>&1; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"could not read the PR",pr:$pr}'
    exit 1
  fi
  if ! jq -e --arg p "$WALK_PREFIX" '.isDraft == true and ((.headRefName // "") | startswith($p))' <<<"$VIEW" >/dev/null; then
    jq -cn --argjson pr "$PR" --argjson view "$VIEW" \
      '{ok:false,error:"not a walk PR: close-walk only closes a draft on a smoke/walk- branch",pr:$pr,headRefName:$view.headRefName,isDraft:$view.isDraft}'
    exit 1
  fi
  if [ "$(jq -r '.state' <<<"$VIEW")" != OPEN ]; then
    jq -cn --argjson pr "$PR" --argjson view "$VIEW" '{ok:true,pr:$pr,closed:false,state:$view.state,branch:$view.headRefName}'
    exit 0
  fi
  if ! timeout 20 gh pr close "$PR" -R "$REPO" --delete-branch \
       --comment "QA walk done or abandoned; closing this PR deletes its preview." >/dev/null 2>&1; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"gh pr close failed; the walk PR is still open",pr:$pr}'
    exit 1
  fi
  jq -cn --argjson pr "$PR" --argjson view "$VIEW" '{ok:true,pr:$pr,closed:true,branch:$view.headRefName}'
  exit 0
fi

RUN_ID=""
if [ "${1:-}" = "--walk" ]; then
  RUN_ID="${2:-}"
  if ! printf '%s' "$RUN_ID" | grep -Eq '^[A-Za-z0-9._-]{1,200}$'; then
    jq -cn '{ok:false,error:"usage: smoke-freeze-pr.sh --walk <run-id> <40-character-target-sha>; the run id is 1-200 chars of [A-Za-z0-9._-]"}'
    exit 2
  fi
  shift 2
fi
TARGET_SHA="${1:-}"
BACKEND_PREFIX="${SMOKE_GATE_BACKEND_PREFIX:-}"; FRONTEND_PREFIX="${SMOKE_GATE_FRONTEND_PREFIX:-}"
. "$(dirname -- "${BASH_SOURCE[0]}")/smoke-gate-layout.sh"; MISSING="$([ -n "$REPO" ] || printf ' SMOKE_GATE_REPO')$(layout_prefix_problems FRONTEND_PREFIX BACKEND_PREFIX)"; if [ -n "$MISSING" ]; then
  jq -cn --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" '{ok:false,error:"SMOKE_GATE_REPO, SMOKE_GATE_BACKEND_PREFIX and SMOKE_GATE_FRONTEND_PREFIX are required, each prefix a relative dir ending in / and distinct from the other",missing:$missing}'
  exit 2
fi
if ! printf '%s' "$TARGET_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  jq -cn '{ok:false,error:"usage: smoke-freeze-pr.sh <40-character-target-sha>"}'
  exit 2
fi

SHA12="${TARGET_SHA:0:12}"
FREEZE_BRANCH="smoke/freeze-$SHA12"
COMMIT_MSG="smoke freeze: pin $BRANCH @ $SHA12 for a QA campaign"
PR_TITLE="[smoke freeze] $BRANCH @ $SHA12 (do not merge)"
PR_BODY="Frozen preview environment for a QA smoke campaign. Pins $BRANCH at \`$TARGET_SHA\`. Never merge this PR — close it when the campaign is done; Render tears the preview down automatically on close."
if [ -n "$RUN_ID" ]; then
  WALK_MAX_OPEN="${SMOKE_GATE_WALK_MAX_OPEN:-2}"
  if ! printf '%s' "$WALK_MAX_OPEN" | grep -Eq '^[1-9][0-9]*$'; then
    jq -cn --arg v "$WALK_MAX_OPEN" '{ok:false,error:"SMOKE_GATE_WALK_MAX_OPEN must be a positive integer",value:$v}'
    exit 2
  fi
  if ! OPEN_PRS="$(timeout 10 gh pr list -R "$REPO" --state open --json number,headRefName --limit 100 2>/dev/null)" ||
     ! jq -e 'type == "array" and length < 100' <<<"$OPEN_PRS" >/dev/null 2>&1; then
    jq -cn '{ok:false,error:"could not count the open walk PRs, so no walk preview is cut"}'
    exit 1
  fi
  OPEN_WALKS="$(jq -c --arg p "$WALK_PREFIX" '[.[] | select((.headRefName // "") | startswith($p)) | .number]' <<<"$OPEN_PRS")"
  if [ "$(jq -r 'length' <<<"$OPEN_WALKS")" -ge "$WALK_MAX_OPEN" ]; then
    jq -cn --argjson open "$OPEN_WALKS" --argjson max "$WALK_MAX_OPEN" \
      '{ok:false,error:"too many walk previews open; finish or close-walk one first",openWalkPrs:$open,max:$max}'
    exit 1
  fi
  FREEZE_BRANCH="$WALK_PREFIX$SHA12-$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-8)"
  COMMIT_MSG="smoke walk: pin $BRANCH @ $SHA12 for QA task run $RUN_ID"
  PR_TITLE="[smoke walk] $BRANCH @ $SHA12 for $RUN_ID (do not merge)"
  PR_BODY="Frozen preview for one QA task run (\`$RUN_ID\`). Pins $BRANCH at \`$TARGET_SHA\`. The QA gate never runs a campaign on it. Never merge this PR: the run closes it when done, and the QA gate closes it if it is left open; Render deletes the preview on close."
fi

# Idempotent-ish: refuse rather than force-push over an existing freeze
# branch for this SHA. A caller that wants a fresh freeze deletes the old
# branch/PR first — this script never overwrites one silently.
if timeout 10 gh api "repos/$REPO/git/ref/heads/$FREEZE_BRANCH" >/dev/null 2>&1; then
  jq -cn --arg branch "$FREEZE_BRANCH" \
    '{ok:false,error:"branch already exists — delete it first or pick a different target",branch:$branch}'
  exit 1
fi

BASE_TREE="$(timeout 10 gh api "repos/$REPO/git/commits/$TARGET_SHA" --jq '.tree.sha // empty' 2>/dev/null)"
if [ -z "$BASE_TREE" ]; then
  jq -cn --arg sha "$TARGET_SHA" '{ok:false,error:"target sha not found in repo",targetSha:$sha}'
  exit 1
fi

# One blob, reused for both marker paths — Git blobs are content-addressed,
# so identical content (the target SHA) always hashes to the same blob sha
# regardless of how many tree entries point at it.
BLOB_SHA="$(jq -cn --arg content "$TARGET_SHA" '{content:$content,encoding:"utf-8"}' | \
  timeout 10 gh api "repos/$REPO/git/blobs" --input - --jq '.sha // empty' 2>/dev/null)"
if [ -z "$BLOB_SHA" ]; then
  jq -cn '{ok:false,error:"failed to create marker blob"}'
  exit 1
fi

NEW_TREE="$(jq -cn \
  --arg base "$BASE_TREE" --arg sha "$BLOB_SHA" --arg be "$BACKEND_PREFIX" --arg fe "$FRONTEND_PREFIX" \
  '{base_tree:$base,tree:[
    {path:($be + ".render-freeze"),mode:"100644",type:"blob",sha:$sha},
    {path:($fe + ".render-freeze"),mode:"100644",type:"blob",sha:$sha}
  ]}' | timeout 10 gh api "repos/$REPO/git/trees" --input - --jq '.sha // empty' 2>/dev/null)"
if [ -z "$NEW_TREE" ]; then
  jq -cn '{ok:false,error:"failed to create marker tree"}'
  exit 1
fi

FREEZE_SHA="$(jq -cn \
  --arg msg "$COMMIT_MSG" \
  --arg tree "$NEW_TREE" --arg parent "$TARGET_SHA" \
  '{message:$msg,tree:$tree,parents:[$parent]}' | \
  timeout 10 gh api "repos/$REPO/git/commits" --input - --jq '.sha // empty' 2>/dev/null)"
if [ -z "$FREEZE_SHA" ]; then
  jq -cn '{ok:false,error:"failed to create marker commit"}'
  exit 1
fi

REF_OK="$(jq -cn --arg ref "refs/heads/$FREEZE_BRANCH" --arg sha "$FREEZE_SHA" '{ref:$ref,sha:$sha}' | \
  timeout 10 gh api "repos/$REPO/git/refs" --input - --jq '.ref // empty' 2>/dev/null)"
if [ -z "$REF_OK" ]; then
  jq -cn --arg sha "$FREEZE_SHA" \
    '{ok:false,error:"failed to create branch ref (marker commit exists but is unreferenced)",freezeSha:$sha}'
  exit 1
fi

PR_NUMBER="$(timeout 20 gh pr create -R "$REPO" --base "$BRANCH" --head "$FREEZE_BRANCH" --draft \
  --title "$PR_TITLE" --body "$PR_BODY" --label "$LABEL" 2>/dev/null | grep -Eo '[0-9]+$' | tail -1)"
if [ -z "$PR_NUMBER" ]; then
  jq -cn --arg branch "$FREEZE_BRANCH" --arg sha "$FREEZE_SHA" \
    '{ok:false,error:"branch and marker commit created but PR creation failed — retry `gh pr create` by hand or clean up the branch",branch:$branch,freezeSha:$sha}'
  exit 1
fi

jq -cn \
  --argjson pr "$PR_NUMBER" --arg branch "$FREEZE_BRANCH" \
  --arg freezeSha "$FREEZE_SHA" --arg targetSha "$TARGET_SHA" --arg run "$RUN_ID" \
  '{prNumber:$pr,branch:$branch,freezeSha:$freezeSha,targetSha:$targetSha}
   + (if $run == "" then {} else {kind:"walk",runId:$run} end)'
