#!/usr/bin/env bash
# smoke-acceptance.py: block extraction (one fence, valid JSON, unique ids),
# provenance against the FROZEN request sources (fences stripped from the PR
# body, so a self-quoting block is unsupported), result-row completeness and
# evidence shape, the derived path, and the report sentence. Hermetic: temp
# dirs only, no network. The barrier and scaffold are never invoked -- nothing
# here reads them, and that is the point (SKILL.md "Acceptance verifier").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/smoke-acceptance.py"
EXAMPLE="$SCRIPT_DIR/../references/acceptance.example.json"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL $1" >&2; exit 1; }
expect() { # <label> <jq-assertion> <json>
  jq -e "$2" <<<"$3" >/dev/null || fail "$1: $3"
}
RUN="$WORK/run"

# Fictional frozen sources holding each example quote inside prose, line-
# wrapped differently from the block (provenance is whitespace-normalised).
Q1="$(jq -r '.items[0].quote' "$EXAMPLE")"
Q2="$(jq -r '.items[1].quote' "$EXAMPLE")"
Q3="$(jq -r '.items[2].quote' "$EXAMPLE")"
block_body() { # <block-json> [prose] -> a PR body carrying ONE fence
  printf '## Summary\n\nFines on the desk and the phone: %s.\n\n```acceptance-v1\n%s\n```\n\nSplit-reason: none\n' "${2:-$Q3}" "$1"
}
new_run() { # [block-json]: a run whose intent/ holds the three frozen sources and a PR body
  rm -rf "$RUN"; mkdir -p "$RUN/intent" "$RUN/evidence/A1"
  # AC1's words, wrapped mid-sentence with a tab: provenance is whitespace-normalised
  printf 'Issue 412\n\nWhen a loan is overdue, a borrower with an overdue loan sees\n   the fine on the borrower card\tbefore the librarian confirms a new loan (the card).\n' > "$RUN/intent/issue-412.md"
  printf '[thread example-desk/1726000000.000100]\ncarol: %s -- north must never read south.\n' "$Q2" > "$RUN/intent/slack-example-desk-1726000000.000100.md"
  block_body "${1:-$(cat "$EXAMPLE")}" > "$RUN/intent/pr-body.md"
}
extract() { python3 "$TOOL" extract "$RUN" "$@" || true; }
check() { python3 "$TOOL" check "$RUN" "$@" || true; }
report() { python3 "$TOOL" report "$RUN"; }
shot() { printf 'png' > "$RUN/evidence/A1/$1"; }
rows() { printf '%s' "$1" > "$RUN/evidence/A1/acceptance-results.json"; }
MET='{"kind":"dom","excerpt":"fine line: $4.00"}'
row() { # <itemId> <verdict> <evidence-json> [blockedBy] [observed-json]
  jq -cn --arg id "$1" --arg v "$2" --argjson ev "$3" --arg b "${4:-}" --argjson ob "${5:-$MET}" \
    '{itemId:$id,verdict:$v,observed:$ob,evidence:$ev,blockedBy:(if $b == "" then null else $b end)}'
}

# --- 1. extract ----------------------------------------------------------------
new_run
OUT="$(extract)"
expect 1-example '.ok == true and .origin == "pr-body" and .itemCount == 3 and .problems == [] and .blocks == [{"carrier":"pr-body.md","status":"present","problems":[]}]' "$OUT"
DOC="$(cat "$RUN/intent/acceptance.json")"
expect 1-doc '.schemaVersion == 1 and .origin == "pr-body" and [.items[].id] == ["AC1","AC2","AC3"] and
  .sources == {"R1":{"request":"issue#412"},"R2":{"request":"slack:example-desk/1726000000.000100"},"R3":{"request":"pr-body"}} and
  .none == [] and (.items | all(.carrier == "pr-body.md" and (has("derived") | not)))' "$DOC"
# Write-once: a second extract is refused unless forced.
expect 1-write-once '.ok == false and (.error | test("written once"))' "$(extract)"
expect 1-force '.ok == true' "$(extract --force)"
# No intent/ dir, no carrier: distinct refusals, nothing written.
rm -rf "$WORK/bare"; mkdir -p "$WORK/bare"
expect 1-no-intent '.ok == false and (.error | test("no intent/"))' "$(python3 "$TOOL" extract "$WORK/bare" || true)"
mkdir -p "$WORK/bare/intent"
expect 1-no-carrier '.ok == false and (.error | test("pr-body.md"))' "$(python3 "$TOOL" extract "$WORK/bare" || true)"
[ ! -e "$WORK/bare/intent/acceptance.json" ] || fail "1-no-carrier: wrote a file"

# An INVALID block is `absent`, written as such with the reasons, and holds no
# items -- the lane derives (§3). One rule for every way a block can be wrong.
bad_block() { # <label> <jq-edit-or-raw-body-marker> <problem-regex> [raw]
  if [ "${4:-}" = raw ]; then new_run; printf '%s' "$2" > "$RUN/intent/pr-body.md"; else new_run "$(jq "$2" "$EXAMPLE")"; fi
  local out; out="$(extract)"
  jq -e --arg re "$3" '.ok == true and .origin == "absent" and .itemCount == 0 and any(.problems[]; test($re))' <<<"$out" >/dev/null || fail "$1: $out"
  jq -e '.origin == "absent" and .items == [] and .sources == {} and .none == []' "$RUN/intent/acceptance.json" >/dev/null || fail "$1: file: $(cat "$RUN/intent/acceptance.json")"
}
bad_block 1-dup-id '.items[1].id = .items[0].id' 'duplicate id'
bad_block 1-bad-id '.items[0].id = "has space"' 'id must match'
bad_block 1-version '.v = 2' 'v must be 1'
bad_block 1-unknown-key '.items[0].screenshot = "x.png"' 'unknown key screenshot'
bad_block 1-unknown-top '.persist = true' 'unknown top-level key persist'
bad_block 1-no-quote 'del(.items[0].quote)' 'quote must be'
bad_block 1-no-when '.items[2].when = ""' 'when must be'
bad_block 1-source-unknown '.items[0].source = "R9"' 'source must name a key of sources'
bad_block 1-source-form '.sources.R1 = "issue 412"' 'is not issue#<n>, slack:'
bad_block 1-surface '.items[0].then.surface = "/desk"' 'then.surface must be'
bad_block 1-surface-api-method '.items[1].then.surface = "api:/api/fines"' 'then.surface must be'
bad_block 1-no-expect 'del(.items[1].then.expect)' 'then.expect must be'
bad_block 1-platform '.items[0].platform = "ios"' 'platform must be one of'
bad_block 1-negative-shape '.items[0].negative = "no fine"' 'negative must be an object'
bad_block 1-empty-items '.items = []' 'items must be a non-empty list'
bad_block 1-none-needs-reason '.items = "none"' 'needs a reason'
bad_block 1-reason-only-with-none '.reason = "x"' 'reason belongs only with items'
bad_block 1-not-json "$(block_body 'not json')" 'not valid JSON' raw
bad_block 1-two-fences "$(block_body "$(cat "$EXAMPLE")")$(block_body '{"v":1}')" '2 acceptance-v1 fences' raw
bad_block 1-unterminated "$(printf '## x\n\n```acceptance-v1\n{"v":1}\n')" 'not terminated' raw
# Tilde fences are fences (CommonMark): one backtick block plus one tilde
# block is two, and a tilde-only block is the block.
bad_block 1-tilde-plus-backtick "$(block_body "$(cat "$EXAMPLE")")$(printf '\n~~~acceptance-v1\n{"v":1}\n~~~\n')" '2 acceptance-v1 fences' raw
bad_block 1-tilde-unterminated "$(printf '~~~acceptance-v1\n{"v":1}\n')" 'not terminated' raw
new_run; printf '## Summary\n\n%s.\n\n~~~~acceptance-v1\n%s\n~~~~~~\n' "$Q3" "$(cat "$EXAMPLE")" > "$RUN/intent/pr-body.md"
expect 1-tilde-block-longer-close '.ok == true and .origin == "pr-body" and .itemCount == 3' "$(extract)"
# A backtick close shorter than its open does not close; a longer one does.
new_run; printf '## Summary\n\n%s.\n\n````acceptance-v1\n%s\n```\n' "$Q3" "$(cat "$EXAMPLE")" > "$RUN/intent/pr-body.md"
expect 1-short-close-is-open '.origin == "absent" and any(.problems[]; test("not terminated"))' "$(extract)"
new_run; printf '## Summary\n\n%s.\n\n```acceptance-v1\n%s\n`````\n' "$Q3" "$(cat "$EXAMPLE")" > "$RUN/intent/pr-body.md"
expect 1-long-close-closes '.ok == true and .origin == "pr-body" and .itemCount == 3' "$(extract)"
# No fence at all is also absent, with no problem to report: nothing was authored.
new_run; printf '## Summary\n\nJust prose.\n' > "$RUN/intent/pr-body.md"
expect 1-no-fence '.ok == true and .origin == "absent" and .problems == [] and .blocks[0].status == "absent"' "$(extract)"
# `pr<n>/` is extract's prefix, never an author's: an authored source key or
# item id carrying one is refused (#928 review 2, finding 1).
bad_block 1-prefixed-source-key '.sources["pr2/R1"] = .sources.R1 | .items[0].source = "pr2/R1" | del(.sources.R1)' 'sources.pr2/R1: key must match'
bad_block 1-prefixed-item-id '.items[0].id = "pr2/AC1"' 'id must match'
# `items: "none"` with a reason is a VALID, empty contract.
new_run "$(jq '.items = "none" | .reason = "dependency bump, no user-observable effect"' "$EXAMPLE")"
expect 1-none '.ok == true and .origin == "pr-body" and .itemCount == 0 and .blocks[0].status == "none"' "$(extract)"
expect 1-none-doc '.none == [{"carrier":"pr-body.md","reason":"dependency bump, no user-observable effect"}] and .items == []' "$(cat "$RUN/intent/acceptance.json")"
# ...and check accepts it: an empty contract that says why.
rows '[]'
expect 1-none-check '.ok == true and .itemCount == 0' "$(check)"
[ "$(report)" = "Acceptance: present(0) — 0 unsupported, 0 missing rows" ] || fail "1-none-sentence: $(report)"

# A freeze campaign carries one block per PR: ids are prefixed `pr<n>/` and a
# `pr-body` source resolves to THAT carrier, never another PR's prose.
new_run; rm "$RUN/intent/pr-body.md"
block_body "$(jq '.items |= [.[0]]' "$EXAMPLE")" > "$RUN/intent/pr-1952-body.md"
block_body "$(jq '.items |= [.[2]]' "$EXAMPLE")" > "$RUN/intent/pr-1953-body.md"
expect 1-freeze '.ok == true and .origin == "pr-body" and .itemCount == 2' "$(extract)"
expect 1-freeze-ids '[.items[] | {id, source, carrier}] == [{"id":"pr1952/AC1","source":"pr1952/R1","carrier":"pr-1952-body.md"},{"id":"pr1953/AC3","source":"pr1953/R3","carrier":"pr-1953-body.md"}] and
  .sources["pr1953/R3"] == {"request":"pr-body"}' "$(cat "$RUN/intent/acceptance.json")"
# One carried PR without a valid block makes the whole campaign unauthored.
printf 'no block here\n' > "$RUN/intent/pr-1953-body.md"
expect 1-freeze-half-authored '.origin == "absent" and .itemCount == 0 and (.blocks | map(.status)) == ["present","absent"]' "$(extract --force)"
# The reviewer's collision: a single-PR block naming `pr2/R1: issue#1` beside
# carried PR 2's `R1: issue#2` must not let an item quoting only issue 2 pass.
new_run "$(jq '.sources = {"pr2/R1":"issue#1"} | .items = [.items[0] | .source = "pr2/R1" | .quote = "only issue two says this"]' "$EXAMPLE")"
printf 'only issue two says this\n' > "$RUN/intent/issue-2.md"
block_body "$(jq '.sources = {"R1":"issue#2"} | .items = [.items[0] | .source = "R1" | .id = "AC9" | .quote = "only issue two says this"]' "$EXAMPLE")" > "$RUN/intent/pr-2-body.md"
expect 1-collision '.origin == "absent" and .blocks[0].status == "invalid" and any(.problems[]; test("pr-body.md: sources.pr2/R1: key must match"))' "$(extract)"
expect 1-collision-check '.ok == false and .provenance == {}' "$(check)"

# --- 2. check: provenance -------------------------------------------------------
new_run; extract >/dev/null
shot ac1.png; shot ac2.txt; shot ac3.png
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC2 met '["evidence/A1/ac2.txt"]'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
OUT="$(check)"
expect 2-all-good '.ok == true and .origin == "pr-body" and .itemCount == 3 and .provenance == {"AC1":"supported","AC2":"supported","AC3":"supported"} and
  .unsupported == [] and .missingRows == [] and .rowProblems == [] and .verdicts.met == 3 and .resultFiles == ["evidence/A1/acceptance-results.json"]' "$OUT"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim" ] || fail "2-sentence: $(report)"
expect 2-builder-claims '.builderClaims == ["AC3"] and .ok == true' "$OUT"
python3 "$TOOL" check "$RUN" >/dev/null || fail "2-exit-code: ok run exited non-zero"
python3 "$TOOL" check "$RUN" --lane A1 >/dev/null || fail "2-lane-flag"
# THE TAUTOLOGY: a pr-body quote that exists only inside the acceptance block.
# AC3's quote is in the prose because new_run put it there; a block quoting
# words the prose never said validates against nothing but itself.
new_run "$(jq '.items[2].quote = "the phone shows the fine in red"' "$EXAMPLE")"; extract >/dev/null
rows "[$(row AC1 met '[]'),$(row AC2 met '[]'),$(row AC3 met '[]')]"
expect 2-self-quoting '.ok == false and .provenance.AC3 == "unsupported" and .builderClaims == [] and
  (.unsupported | map(.id)) == ["AC3"] and (.unsupported[0].reason | test("its acceptance-v1 block removed"))' "$(check)"
# ...even when the block is the ONLY thing in the body.
new_run; printf '```acceptance-v1\n%s\n```\n' "$(cat "$EXAMPLE")" > "$RUN/intent/pr-body.md"; extract >/dev/null
expect 2-block-only-body '.provenance.AC3 == "unsupported" and .provenance.AC1 == "supported"' "$(check)"
# PROVENANCE FAILS CLOSED ON CONTENT, NOT SYNTAX (#928 review 2, finding 2).
# The pr-body search text is the frozen body minus the ONE extracted block. If
# `acceptance-v1` still occurs anywhere in what is left -- in whatever Markdown
# form, or in none -- the PR body is unavailable and every item citing it is
# unsupported, even one whose quote really is in the prose. No parser has to
# recognise the form that hides a quote.
pr_body_item() { # <quote> -> an authored doc with one pr-body item
  jq -cn --arg q "$1" '{schemaVersion:1,origin:"pr-body",sources:{R3:{request:"pr-body"}},
    items:[{id:"AC3",source:"R3",quote:$q,when:"open",then:{surface:"native:loans",expect:"x"},platform:"native",carrier:"pr-body.md"}]}' \
    > "$RUN/intent/acceptance.json"
}
HIDDEN="the phone shows the fine in red"
UNAVAILABLE='.provenance.AC3 == "unsupported" and (.unsupported[0].reason | test("R3 is unavailable: the PR body mentions acceptance-v1 outside its one block"))'
hidden_form() { # <label> <extra markdown appended after the one real block>
  new_run; { block_body "$(cat "$EXAMPLE")"; printf '\n%s\n' "$2"; } > "$RUN/intent/pr-body.md"
  pr_body_item "$HIDDEN"; expect "$1-hidden-quote" "$UNAVAILABLE" "$(check)"
  pr_body_item "$Q3";     expect "$1-prose-quote" "$UNAVAILABLE" "$(check)"
}
hidden_form 2-blockquote "$(printf '> ```acceptance-v1\n> {"note":"%s"}\n> ```' "$HIDDEN")"
hidden_form 2-list "$(printf -- '- first\n- second\n\n    ```acceptance-v1\n    %s\n    ```' "$HIDDEN")"
hidden_form 2-nested-list "$(printf -- '- outer\n  - inner\n\n        ```acceptance-v1\n        %s\n        ```' "$HIDDEN")"
hidden_form 2-second-tilde "$(printf '~~~acceptance-v1\n{"note":"%s"}\n~~~' "$HIDDEN")"
hidden_form 2-info-suffix "$(printf '~~~ acceptance-v1 json\n%s\n~~~' "$HIDDEN")"
hidden_form 2-unterminated "$(printf '```acceptance-v1\n%s' "$HIDDEN")"
hidden_form 2-prose-mention "The acceptance-v1 block above says $HIDDEN."
# ...and extract agrees where it can see the second fence: the campaign derives.
new_run; { block_body "$(cat "$EXAMPLE")"; printf '\n~~~acceptance-v1\n{"v":1}\n~~~\n'; } > "$RUN/intent/pr-body.md"
expect 2-second-fence-extract '.origin == "absent"' "$(extract)"
# The normal single block still supports a quote in the PR description prose
# -- before or after the block, closed by a longer fence, or saved with CRLF --
# and never one that lives only inside the block.
new_run; pr_body_item "$Q3"
expect 2-one-block-prose '.provenance.AC3 == "supported"' "$(check)"
pr_body_item "$(jq -r '.items[0].then.expect' "$EXAMPLE")"
expect 2-one-block-self '.provenance.AC3 == "unsupported" and (.unsupported[0].reason | test("block removed"))' "$(check)"
new_run; printf 'prose\n```acceptance-v1\n%s\n`````\nafter %s\n' "$HIDDEN" "$Q3" > "$RUN/intent/pr-body.md"
pr_body_item "$HIDDEN"; expect 2-long-close-hidden '.provenance.AC3 == "unsupported"' "$(check)"
pr_body_item "$Q3";     expect 2-long-close-prose-after '.provenance.AC3 == "supported"' "$(check)"
new_run; printf '```acceptance-v1\r\n%s\r\n```\r\nprose %s\r\n' "$HIDDEN" "$Q3" > "$RUN/intent/pr-body.md"
pr_body_item "$HIDDEN"; expect 2-crlf-hidden '.provenance.AC3 == "unsupported"' "$(check)"
pr_body_item "$Q3";     expect 2-crlf-prose-after '.provenance.AC3 == "supported"' "$(check)"
new_run; block_body "$(cat "$EXAMPLE")" | sed 's/$/\r/' > "$RUN/intent/pr-body.md"
expect 2-crlf-extract '.ok == true and .origin == "pr-body" and .itemCount == 3' "$(extract)"
# Only the PR body is held to this: an issue that mentions acceptance-v1 is
# still searched as frozen.
new_run; printf 'see acceptance-v1\n' >> "$RUN/intent/issue-412.md"; extract >/dev/null
expect 2-issue-mention '.provenance.AC1 == "supported"' "$(check)"
# `carrier` is derived from the item id, never trusted: a pr-body item stored
# with carrier issue-412.md does not read the issue as the PR body.
new_run; extract >/dev/null
jq --arg q "$Q1" '.items[2].carrier = "issue-412.md" | .items[2].quote = $q' "$RUN/intent/acceptance.json" > "$RUN/intent/a.tmp"
mv "$RUN/intent/a.tmp" "$RUN/intent/acceptance.json"
expect 2-carrier-alias '.provenance.AC3 == "unsupported" and any(.unsupported[]; .reason | test("stores carrier .issue-412.md. but its id resolves to intent/pr-body.md"))' "$(check)"

# A quote must match the named source, not any frozen file: AC1's words in the
# Slack thread do not support an item that names the issue.
new_run "$(jq '.items[0].source = "R2"' "$EXAMPLE")"; extract >/dev/null
expect 2-wrong-source '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("slack-example-desk"))' "$(check)"
# An unfrozen source (named, never fetched) is unsupported, naming the file.
new_run; rm "$RUN/intent/issue-412.md"; extract >/dev/null
expect 2-unfrozen '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("unfrozen: intent/issue-412.md is missing"))' "$(check)"
# SOURCE BINDING IS DERIVED, NEVER TRUSTED (#928 reviews 1-2). A stored
# `frozen` that differs from what the request resolves to -- another issue, a
# traversal, an absolute path -- is unsupported, whatever is at that path.
alias_frozen() { # <jq-edit on sources> : rewrite the extracted doc's sources
  jq "$1" "$RUN/intent/acceptance.json" > "$RUN/intent/a.tmp"; mv "$RUN/intent/a.tmp" "$RUN/intent/acceptance.json"
}
new_run; extract >/dev/null
printf 'Issue 2: %s\n' "$Q1" > "$RUN/intent/issue-2.md"
alias_frozen '.sources.R1.frozen = "issue-2.md"'
expect 2-alias-other-issue '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("stores frozen .issue-2.md. but its request resolves to intent/issue-412.md"))' "$(check)"
printf '%s\n' "$Q1" > "$RUN/evidence/A1/invented.txt"
alias_frozen '.sources.R1.frozen = "../evidence/A1/invented.txt"'
expect 2-alias-traversal '.provenance.AC1 == "unsupported"' "$(check)"
alias_frozen ".sources.R1.frozen = \"$RUN/evidence/A1/invented.txt\""
expect 2-alias-absolute '.provenance.AC1 == "unsupported"' "$(check)"
alias_frozen '.sources.R1.frozen = "issue-412.md"'   # a stored name that AGREES is fine
expect 2-alias-agreeing '.provenance.AC1 == "supported"' "$(check)"
alias_frozen '.sources.R1.request = "issue#2"'       # the request decides: now it is issue-2.md
expect 2-request-decides '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("stores frozen .issue-412.md. but its request resolves to intent/issue-2.md"))' "$(check)"
alias_frozen 'del(.sources.R1.frozen) | .sources.R1.request = "issue#2"'
expect 2-request-decides-no-stored '.provenance.AC1 == "supported"' "$(check)"   # issue-2.md holds Q1
alias_frozen '.sources.R1.request = "file:issue-412.md"'
expect 2-request-form-checked 'any(.problems[]; test("sources.R1: must be"))' "$(check)"
# A symlink anywhere on the way is refused: the file, or intent/ itself.
new_run; extract >/dev/null
mv "$RUN/intent/issue-412.md" "$RUN/evidence/A1/real-issue.md"; ln -s ../evidence/A1/real-issue.md "$RUN/intent/issue-412.md"
expect 2-symlinked-source '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("intent/issue-412.md is a symlink"))' "$(check)"
new_run; extract >/dev/null
mv "$RUN/intent" "$WORK/intent-aside"; ln -s "$WORK/intent-aside" "$RUN/intent"
expect 2-symlinked-intent-dir '.ok == false and (.provenance | to_entries | all(.value == "unsupported")) and (.unsupported[0].reason | test("reached through a symlink"))' "$(check)"
rm "$RUN/intent"; mv "$WORK/intent-aside" "$RUN/intent"
expect 2-symlink-restored '.provenance.AC1 == "supported"' "$(check)"
# The parent-directory race (#928 review 2, finding 3): intent/ is swapped for
# a link to a directory of fabricated sources AFTER it was opened. The read
# must still come from the directory that was verified.
mkdir -p "$WORK/fake"; printf 'fabricated\n' > "$WORK/fake/issue-412.md"
RACE="$(python3 - "$TOOL" "$RUN" "$WORK/fake" <<'PY'
import importlib.util, os, sys
sys.dont_write_bytecode = True
tool, run, fake = sys.argv[1:]
spec = importlib.util.spec_from_file_location("acc", tool)
acc = importlib.util.module_from_spec(spec); spec.loader.exec_module(acc)
real_open = os.open
def racing_open(path, flags, *a, **kw):
    fd = real_open(path, flags, *a, **kw)
    if flags & os.O_DIRECTORY:   # just opened intent/: swap it for a link
        os.rename(os.path.join(run, "intent"), os.path.join(run, "intent-aside"))
        os.symlink(fake, os.path.join(run, "intent"))
    return fd
acc.os.open = racing_open
text, why = acc.read_frozen(run, "issue-412.md")
os.unlink(os.path.join(run, "intent"))
os.rename(os.path.join(run, "intent-aside"), os.path.join(run, "intent"))
print("fabricated" if text and "fabricated" in text else "verified" if text else "error:" + why)
PY
)"
[ "$RACE" = verified ] || fail "2-parent-dir-race: $RACE"

# Whitespace is normalised (issue-412.md wraps AC1 mid-sentence and holds a
# tab); case and punctuation are not.
new_run "$(jq '.items[0].quote |= ascii_upcase' "$EXAMPLE")"; extract >/dev/null
expect 2-case-sensitive '.provenance.AC1 == "unsupported"' "$(check)"
new_run "$(jq '.items[1].quote = "the fines list should refuse another branch'"'"'s token with 403!"' "$EXAMPLE")"; extract >/dev/null
expect 2-punctuation '.provenance.AC2 == "unsupported"' "$(check)"

# --- 3. check: rows -------------------------------------------------------------
new_run; extract >/dev/null; shot ac1.png; shot ac3.png
# A missing row is a completeness failure; an unknown itemId is reported and
# ignored; a duplicate row is a problem.
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC9 met '["evidence/A1/ac1.png"]')]"
expect 3-missing-and-unknown '.ok == false and .missingRows == ["AC2","AC3"] and .unknownRows == [{"file":"evidence/A1/acceptance-results.json","itemId":"AC9"}] and .rowProblems == []' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 2 missing rows, 1 builder claim" ] || fail "3-sentence: $(report)"
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC2 blocked '[]' 'seat lost'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
expect 3-duplicate-row 'any(.rowProblems[]; .itemId == "AC1" and any(.problems[]; test("duplicate row")))' "$(check)"
# No results file at all: every item is a missing row, and the file is named.
rm "$RUN/evidence/A1/acceptance-results.json"
expect 3-no-file '.missingRows == ["AC1","AC2","AC3"] and .resultFiles == []' "$(check)"
expect 3-no-file-named-lane '.missingRows == ["AC1","AC2","AC3"] and any(.problems[]; test("evidence/A1/acceptance-results.json: missing"))' "$(check --lane A1)"
# {rows:[...]} is accepted; garbage is a problem.
rows "{\"rows\":[$(row AC1 met '["evidence/A1/ac1.png"]')]}"
expect 3-rows-object '.missingRows == ["AC2","AC3"] and .rowProblems == []' "$(check)"
rows 'not json'
expect 3-garbage 'any(.problems[]; test("not a JSON list of rows"))' "$(check)"
# Rows from two lanes merge; the same item in both is a duplicate.
mkdir -p "$RUN/evidence/A2"; printf 'png' > "$RUN/evidence/A2/x.png"
rows "[$(row AC1 met '["evidence/A1/ac1.png"]')]"
printf '%s' "[$(row AC2 met '["evidence/A2/x.png"]'),$(row AC3 met '["evidence/A2/x.png"]')]" > "$RUN/evidence/A2/acceptance-results.json"
expect 3-two-lanes '.ok == true and .resultFiles == ["evidence/A1/acceptance-results.json","evidence/A2/acceptance-results.json"]' "$(check)"
printf '%s' "[$(row AC1 met '["evidence/A2/x.png"]'),$(row AC2 met '["evidence/A2/x.png"]'),$(row AC3 met '["evidence/A2/x.png"]')]" > "$RUN/evidence/A2/acceptance-results.json"
expect 3-two-lanes-duplicate 'any(.rowProblems[]; .itemId == "AC1" and .file == "evidence/A2/acceptance-results.json" and any(.problems[]; test("first in evidence/A1")))' "$(check)"
rm -rf "$RUN/evidence/A2"

# Verdict shape, one rule per verdict.
row_problem() { # <label> <row-json> <problem-regex>
  rows "[$2,$(row AC2 met '["evidence/A1/ac1.png"]'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
  local out; out="$(check)"
  jq -e --arg re "$3" '.ok == false and any(.rowProblems[]; .itemId == "AC1" and any(.problems[]; test($re)))' <<<"$out" >/dev/null || fail "$1: $out"
}
row_ok() { # <label> <row-json>
  rows "[$2,$(row AC2 met '["evidence/A1/ac1.png"]'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
  expect "$1" '.ok == true' "$(check)"
}
row_problem 3-bad-verdict "$(row AC1 passed '["evidence/A1/ac1.png"]')" 'verdict must be one of'
row_problem 3-met-no-evidence "$(row AC1 met '[]')" 'met needs at least one existing evidence file'
row_problem 3-met-missing-file "$(row AC1 met '["evidence/A1/never.png"]')" 'not an existing, non-empty file inside the run: evidence/A1/never.png'
: > "$RUN/evidence/A1/empty.png"
row_problem 3-met-empty-file "$(row AC1 met '["evidence/A1/empty.png"]')" 'non-empty file'
row_problem 3-met-absolute "$(row AC1 met "[\"$RUN/evidence/A1/ac1.png\"]")" 'inside the run'
row_problem 3-met-escape "$(row AC1 met '["../run/evidence/A1/ac1.png"]')" 'inside the run'
row_problem 3-not-met-no-excerpt "$(row AC1 not_met '["evidence/A1/ac1.png"]' '' '{"kind":"screenshot-only","excerpt":""}')" 'not_met needs a non-empty observed.excerpt'
row_problem 3-met-no-observed "$(row AC1 met '["evidence/A1/ac1.png"]' '' 'null')" 'met needs a non-empty observed.excerpt'
row_problem 3-observed-kind "$(row AC1 met '["evidence/A1/ac1.png"]' '' '{"kind":"vibes","excerpt":"x"}')" 'observed.kind must be one of'
LONG="$(printf 'x%.0s' $(seq 501))"
row_problem 3-excerpt-cap "$(row AC1 met '["evidence/A1/ac1.png"]' '' "{\"kind\":\"text\",\"excerpt\":\"$LONG\"}")" 'at most 500 characters'
row_problem 3-unknown-row-key "$(row AC1 met '["evidence/A1/ac1.png"]' | jq -c '.note = "x"')" 'unknown key note'
row_ok 3-not-met-ok "$(row AC1 not_met '["evidence/A1/ac1.png"]')"
# not_demonstrable keeps the lane's existing bar: a blocker AND an artifact of
# the furthest state; blocked needs the blocker only, never counts as coverage.
row_problem 3-nd-no-blocker "$(row AC1 not_demonstrable '["evidence/A1/ac1.png"]')" 'not_demonstrable needs blockedBy'
row_problem 3-nd-no-artifact "$(row AC1 not_demonstrable '[]' 'no overdue seed row on this build')" 'needs an artifact of the furthest state'
row_ok 3-nd-ok "$(row AC1 not_demonstrable '["evidence/A1/ac1.png"]' 'no overdue seed row on this build')"
row_problem 3-blocked-no-blocker "$(row AC1 blocked '[]')" 'blocked needs blockedBy'
row_problem 3-blocked-empty-blocker "$(row AC1 blocked '[]' ' ')" 'blockedBy must be null or a non-empty string'
row_ok 3-blocked-ok "$(row AC1 blocked '[]' 'coordinator seat lost before the lane started')"
rows "[$(row AC1 blocked '[]' 'seat lost'),$(row AC2 not_demonstrable '["evidence/A1/ac1.png"]' 'no south branch on this build'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
expect 3-verdict-counts '.ok == true and .verdicts == {"met":1,"not_met":0,"not_demonstrable":1,"blocked":1}' "$(check)"

# --- 4. the derived path -----------------------------------------------------------
new_run; printf '## Summary\n\nJust prose.\n' > "$RUN/intent/pr-body.md"; extract >/dev/null
expect 4-absent-refused '.ok == false and .origin == "absent" and any(.problems[]; test("origin is absent") and test("derive"))' "$(check)"
[ "$(report)" = "Acceptance: absent — 0 unsupported, 0 missing rows" ] || fail "4-sentence-absent: $(report)"
# The lane derives from the frozen request sources into the same file.
derived() { # <jq-edit on the derived doc>
  jq "$1" <<<'{"schemaVersion":1,"origin":"derived","sources":{"R1":{"request":"issue#412","frozen":"issue-412.md"},"R2":{"request":"slack:example-desk/1726000000.000100","frozen":"slack-example-desk-1726000000.000100.md"}},
    "items":[{"id":"AC1","source":"R1","quote":"'"$Q1"'","when":"open the desk","then":{"surface":"web:/desk","expect":"fine shown"},"platform":"web","derived":true},
             {"id":"AC2","source":"R2","quote":"'"$Q2"'","when":"GET fines","then":{"surface":"api:GET /api/fines","expect":"403"},"platform":"api","derived":true}]}' > "$RUN/intent/acceptance.json"
}
derived '.'; shot ac1.png
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC2 met '["evidence/A1/ac1.png"]')]"
expect 4-derived-ok '.ok == true and .origin == "derived" and .itemCount == 2' "$(check)"
[ "$(report)" = "Acceptance: derived(2) — 0 unsupported, 0 missing rows" ] || fail "4-sentence-derived: $(report)"
derived 'del(.items[1].derived)'
expect 4-derived-flag-required '.ok == false and any(.problems[]; test("item AC2: a derived contract marks every item derived: true"))' "$(check)"
# A derived contract comes from the frozen request sources, never the PR prose:
# a pr-body source stops the check (an authored block's pr-body items stay
# builder claims, section 2).
derived '.sources.R3 = {"request":"pr-body"} | .items[1].source = "R3"'
expect 4-derived-no-pr-body '.ok == false and .stopped != null and any(.problems[]; test("sources.R3: a derived contract derives from the frozen request sources, never the PR prose"))' "$(check)"
derived '.origin = "pr-body"'
expect 4-authored-cannot-be-derived 'any(.problems[]; test("authored contract cannot carry derived items"))' "$(check)"
derived '.items[1].id = "AC1"'
expect 4-derived-dup-id 'any(.problems[]; test("duplicate id"))' "$(check)"
derived '.items[1].quote = "words the thread never said"'
expect 4-derived-provenance '.provenance.AC2 == "unsupported"' "$(check)"
# THE SAME ITEM RULE AS THE BLOCK (#928 review 5): a derived item missing
# when/then/platform, or carrying an unknown key, is a problem, not a pass.
derived 'del(.items[0].when) | del(.items[0].then) | del(.items[0].platform)'
expect 4-derived-item-rule '.ok == false and any(.problems[]; test("item AC1: when must be")) and any(.problems[]; test("item AC1: then must be")) and any(.problems[]; test("item AC1: platform must be"))' "$(check)"
derived '.items[0].then.surface = "/desk"'
expect 4-derived-surface 'any(.problems[]; test("item AC1: then.surface must be"))' "$(check)"
derived '.items[0].screenshot = "x.png"'
expect 4-derived-unknown-key 'any(.problems[]; test("item AC1: unknown key screenshot"))' "$(check)"
derived '.persist = true'
expect 4-doc-unknown-key 'any(.problems[]; test("unknown top-level key persist"))' "$(check)"
# An EMPTY derived contract is a claim and must say why: none: [{reason}].
derived '.items = []'
expect 4-derived-empty-needs-none '.ok == false and any(.problems[]; test("empty contract needs none"))' "$(check)"
derived '.items = [] | .none = [{"reason":"dependency bump; the frozen thread asks for nothing user-observable"}]'
expect 4-derived-empty-with-none '.ok == true and .itemCount == 0' "$(check)"
[ "$(report)" = "Acceptance: derived(0) — 0 unsupported, 0 missing rows" ] || fail "4-sentence-derived-empty: $(report)"
derived '.items = [] | .none = [{"why":"x"}]'
expect 4-none-shape 'any(.problems[]; test("none must be a list of"))' "$(check)"
# Doc-level garbage.
printf 'nope' > "$RUN/intent/acceptance.json"
expect 4-doc-garbage '.ok == false and any(.problems[]; test("unreadable or not JSON"))' "$(check)"
printf '{"schemaVersion":2}' > "$RUN/intent/acceptance.json"
expect 4-doc-version 'any(.problems[]; test("schemaVersion 1"))' "$(check)"
rm "$RUN/intent/acceptance.json"
expect 4-doc-missing '.ok == false and .origin == "absent" and any(.problems[]; test("run .extract. at freeze"))' "$(check)"
[ "$(report)" = "Acceptance: absent — 0 unsupported, 0 missing rows" ] || fail "4-sentence-missing: $(report)"

# --- 5. nothing outside intent/ is written; no bytecode is left -----------------------
new_run; extract >/dev/null; check >/dev/null; report >/dev/null
[ -z "$(find "$RUN" -name '.tmp-*' -o -name '__pycache__')" ] || fail "5-leftovers: $(find "$RUN" -name '.tmp-*' -o -name '__pycache__')"
[ ! -e "$SCRIPT_DIR/__pycache__" ] || fail "5-bytecode beside the scripts"

# --- 6. data items and the stop/zero distinction -----------------------------------
# A data re-check has no screen or endpoint: the item reads a relation, and its
# row names the build-pinned object it queried and the query file. Every other
# fail-closed check (source identity, quote provenance, evidence paths) still
# applies to it.
DATA="$SCRIPT_DIR/../references/acceptance.data.example.json"
QD="$(jq -r '.items[0].quote' "$DATA")"
new_data_run() { # [block-json]
  new_run "${1:-$(cat "$DATA")}"
  printf 'Issue 413\n\nAfter the rebuild,\n  %s, and the desk total must agree.\n' "$QD" > "$RUN/intent/issue-413.md"
  printf 'select count(*) from LANTERN_CI.PR_88_FINES.FCT_LOAN_FINES where fine_cents < 0;\n' > "$RUN/evidence/A1/ad1.sql"
  printf '[{"COUNT(*)":0}]\n' > "$RUN/evidence/A1/ad1.result.json"
}
OBJ='{"relation":"LANTERN_CI.PR_88_FINES.FCT_LOAN_FINES","build":"ci-run-5521"}'
QOBS='{"kind":"query","excerpt":"COUNT(*) = 0"}'
data_row() { # <verdict> [jq-edit]
  row AD1 "$1" '["evidence/A1/ad1.result.json"]' '' "$QOBS" \
    | jq -c --argjson o "$OBJ" ".object = \$o | .query = \"evidence/A1/ad1.sql\" | ${2:-.}"
}
new_data_run
expect 6-data-extract '.ok == true and .origin == "pr-body" and .itemCount == 1 and .problems == []' "$(extract)"
rows "[$(data_row met)]"
expect 6-data-ok '.ok == true and .stopped == null and .provenance == {"AD1":"supported"} and .rowProblems == [] and .verdicts.met == 1' "$(check)"
python3 "$TOOL" check "$RUN" >/dev/null || fail "6-data-exit-code"
[ "$(report)" = "Acceptance: present(1) — 0 unsupported, 0 missing rows" ] || fail "6-data-sentence: $(report)"
rows "[$(data_row not_met)]"
expect 6-data-not-met-ok '.ok == true and .verdicts.not_met == 1' "$(check)"
# A never-attempted data item has no object to name; blocked keeps its own rule.
rows "[$(data_row blocked 'del(.object, .query) | .observed = null | .evidence = [] | .blockedBy = "CI run never built the fines model"')]"
expect 6-data-blocked-ok '.ok == true and .verdicts.blocked == 1' "$(check)"
data_row_problem() { # <label> <row-json> <problem-regex>
  rows "[$2]"
  local out; out="$(check)"
  jq -e --arg re "$3" '.ok == false and .stopped == null and any(.rowProblems[]; .itemId == "AD1" and any(.problems[]; test($re)))' <<<"$out" >/dev/null || fail "$1: $out"
}
data_row_problem 6-data-no-object "$(data_row met 'del(.object)')" 'met on a data item needs object'
data_row_problem 6-data-not-met-no-object "$(data_row not_met 'del(.object)')" 'not_met on a data item needs object'
data_row_problem 6-data-no-build "$(data_row met 'del(.object.build)')" 'object.build must name the CI run'
data_row_problem 6-data-blank-build "$(data_row met '.object.build = " "')" 'object.build must name the CI run'
data_row_problem 6-data-unqualified-object "$(data_row met '.object.relation = "FCT_LOAN_FINES"')" 'object.relation must be a fully qualified'
data_row_problem 6-data-other-table "$(data_row met '.object.relation = "LANTERN_CI.PR_88_FINES.FCT_LOANS"')" 'object.relation LANTERN_CI.PR_88_FINES.FCT_LOANS is not the table the item names'
data_row_problem 6-data-quoted-case "$(data_row met '.object.relation = "LANTERN_CI.PR_88_FINES.\"fct_loan_fines\""')" 'is not the table the item names'
rows "[$(data_row met '.object.relation = "lantern_ci.pr_88_fines.fct_loan_fines"')]"
expect 6-data-unquoted-case-folds '.ok == true' "$(check)"
rows "[$(data_row met '.object.relation = "PR_88_FINES.\"FCT_LOAN_FINES\""')]"
expect 6-data-two-part-quoted '.ok == true' "$(check)"
data_row_problem 6-data-object-extra-key "$(data_row met '.object.note = "x"')" 'object must be .relation, build. and nothing else'
data_row_problem 6-data-no-query "$(data_row met 'del(.query)')" 'met on a data item needs query'
data_row_problem 6-data-query-missing-file "$(data_row met '.query = "evidence/A1/never.sql"')" 'query is not an existing, non-empty file inside the run: evidence/A1/never.sql'
data_row_problem 6-data-query-escape "$(data_row met '.query = "../run/evidence/A1/ad1.sql"')" 'query is not an existing'
data_row_problem 6-data-query-nul "$(data_row met '.query = "evidence/A1/ad1.sql\u0000x"')" 'query is not an existing'
data_row_problem 6-data-evidence-nul "$(data_row met '.evidence = ["evidence/A1/ad1.result.json\u0000x"]')" 'not an existing, non-empty file inside the run'
data_row_problem 6-data-evidence-missing "$(data_row met '.evidence = ["evidence/A1/never.json"]')" 'not an existing, non-empty file inside the run: evidence/A1/never.json'
data_row_problem 6-data-no-evidence "$(data_row met '.evidence = []')" 'met needs at least one existing evidence file'
data_row_problem 6-data-no-excerpt "$(data_row met '.observed.excerpt = ""')" 'met needs a non-empty observed.excerpt'
data_row_problem 6-data-dom-kind "$(data_row met '.observed.kind = "dom"')" 'a data item observes only by query'
data_row_problem 6-data-nd-no-blocker "$(data_row not_demonstrable)" 'not_demonstrable needs blockedBy'
# The object and query keys, and the query kind, belong to data rows only.
new_run; extract >/dev/null; shot ac1.png; shot ac3.png; printf 'select 1;\n' > "$RUN/evidence/A1/ad1.sql"
row_problem 6-web-row-object "$(row AC1 met '["evidence/A1/ac1.png"]' | jq -c --argjson o "$OBJ" '.object = $o')" 'object belongs only to a data item'
row_problem 6-web-row-query "$(row AC1 met '["evidence/A1/ac1.png"]' | jq -c '.query = "evidence/A1/ad1.sql"')" 'query belongs only to a data item'
row_problem 6-web-row-query-kind "$(row AC1 met '["evidence/A1/ac1.png"]' '' "$QOBS")" 'observed.kind query belongs to a data item'
# The contract item names a fully qualified relation, and platform data pairs
# with a data: surface both ways. Each is the ONLY problem, so the platform
# itself is accepted.
only_problem() { # <label> <jq-edit on the data block> <problem-regex>
  new_data_run "$(jq "$2" "$DATA")"
  local out; out="$(extract)"
  jq -e --arg re "$3" '.origin == "absent" and (.problems | length) == 1 and (.problems[0] | test($re))' <<<"$out" >/dev/null || fail "$1: $out"
}
only_problem 6-data-surface-unqualified '.items[0].then.surface = "data:FCT_LOAN_FINES"' 'then.surface must be .* data:<schema>.<table>'
only_problem 6-data-surface-four-part '.items[0].then.surface = "data:A.B.C.D"' 'then.surface must be'
only_problem 6-data-platform-web-surface '.items[0].then.surface = "web:/desk"' 'platform data and a data:<schema>.<table> surface go together'
only_problem 6-data-surface-web-platform '.items[0].platform = "web"' 'platform data and a data:<schema>.<table> surface go together'
only_problem 6-data-source-unknown '.items[0].source = "R9"' 'source must name a key of sources'
new_data_run "$(jq '.items[0].then.surface = "data:LANTERN_CI.\"Pr 88\".FCT_LOAN_FINES"' "$DATA")"
expect 6-data-surface-quoted '.origin == "pr-body" and .problems == []' "$(extract)"
# A doubled quote inside a quoted identifier is one literal quote: valid in the
# surface and the row, and the table binding decodes it before comparing.
ESC='LANTERN_CI.PR_88_FINES."FCT_""LOAN""_FINES"'
new_data_run "$(jq '.items[0].then.surface = "data:FINES.\"FCT_\"\"LOAN\"\"_FINES\""' "$DATA")"
expect 6-data-surface-escaped-quote '.origin == "pr-body" and .problems == []' "$(extract)"
rows "[$(data_row met ".object.relation = $(jq -Rn --arg r "$ESC" '$r')")]"
expect 6-data-escaped-quote-binds '.ok == true and .stopped == null' "$(check)"
rows "[$(data_row met '.object.relation = "LANTERN_CI.PR_88_FINES.\"FCT_\"\"LOAN_FINES\""')]"
expect 6-data-escaped-quote-other-table '.ok == false and any(.rowProblems[].problems[]; test("is not the table the item names"))' "$(check)"
rows "[$(data_row met '.object.relation = "LANTERN_CI.PR_88_FINES.\"FCT_\"LOAN_FINES\""')]"
expect 6-data-lone-inner-quote '.ok == false and any(.rowProblems[].problems[]; test("object.relation must be a fully qualified"))' "$(check)"
# Provenance is unchanged for a data item: a quote the issue never said, or a
# source that was never frozen, is unsupported.
new_data_run "$(jq '.items[0].quote = "fines are never negative"' "$DATA")"; extract >/dev/null
rows "[$(data_row met)]"
expect 6-data-bad-quote '.ok == false and .stopped == null and .provenance.AD1 == "unsupported" and (.unsupported[0].reason | test("quote not found in intent/issue-413.md"))' "$(check)"
new_data_run "$(jq '.sources.R1 = "issue#414"' "$DATA")"; extract >/dev/null
rows "[$(data_row met)]"
expect 6-data-unfrozen-source '.ok == false and .provenance.AD1 == "unsupported" and (.unsupported[0].reason | test("unfrozen: intent/issue-414.md is missing"))' "$(check)"
new_data_run; extract >/dev/null
alias_frozen '.sources.R1.frozen = "issue-412.md"'
rows "[$(data_row met)]"
expect 6-data-source-alias '.provenance.AD1 == "unsupported" and (.unsupported[0].reason | test("stores frozen .issue-412.md. but its request resolves to intent/issue-413.md"))' "$(check)"
# A refused contract is a STOP, never a clean zero: the JSON names it and the
# sentence cannot be mistaken for "nothing missing".
new_run; derived '.items[1].platform = "ios"'
OUT="$(check)"
expect 6-stopped '.ok == false and .stopped == "1 contract problem" and .itemCount == 2 and .provenance == {}' "$OUT"
[ "$(report)" = "Acceptance: derived(2) — stopped: 1 contract problem, nothing checked" ] || fail "6-stopped-sentence: $(report)"
derived '.items[0].platform = "ios" | .items[1].platform = "ios"'
[ "$(report)" = "Acceptance: derived(2) — stopped: 2 contract problems, nothing checked" ] || fail "6-stopped-sentence-plural: $(report)"
derived '.items = [] | .none = [{"reason":"dependency bump"}]'
expect 6-clean-zero-not-stopped '.ok == true and has("stopped") and .stopped == null' "$(check)"
rm "$RUN/intent/acceptance.json"
expect 6-missing-is-stopped '.stopped == "contract missing"' "$(check)"

# --- 7. one adjudicated result -------------------------------------------------
new_run; extract >/dev/null
shot a.png
all_met() { rows "[$(row AC1 met '["evidence/A1/a.png"]'),$(row AC2 "${1:-met}" '["evidence/A1/a.png"]'),$(row AC3 met '["evidence/A1/a.png"]')]"; }
all_met
mkdir -p "$RUN/coordinator" "$RUN/challenger"
challenger() { printf '%s' "$1" > "$RUN/challenger/acceptance-check.json"; }
record() { # <AC2 status> [extra items json, comma-led] : a documented record covering AC1-AC3
  challenger "{\"obligations\":[{\"id\":\"O1\",\"status\":\"covered\",\"itemId\":\"AC1\"},{\"id\":\"O2\",\"status\":\"missing\",\"itemId\":null}],\"items\":[{\"itemId\":\"AC1\",\"status\":\"supported\"},{\"itemId\":\"AC2\",\"status\":\"$1\"},{\"itemId\":\"AC3\",\"status\":\"supported\"}${2:-}]}"
}
rulings() { printf '%s' "$1" > "$RUN/coordinator/acceptance-rulings.json"; }
expect 7-no-dispute '.ok == true and .unruled == [] and .outcomes == {"AC1":"met","AC2":"met","AC3":"met"}' "$(check)"
record narrowed
expect 7-dispute-is-unruled '.ok == false and .unruled == ["AC2"] and .outcomes.AC2 == "unruled" and .outcomes.AC1 == "met"' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 disputed and unruled" ] || fail "7-unruled-sentence: $(report)"
challenger '{"items":[{"id":"AC1","support":"supported"},{"id":"AC2","support":"unsupported"},{"id":"AC3","mapping":"supported"}]}'
expect 7-older-record-shapes-are-read '.ok == false and .unruled == ["AC2"] and .challengerRecord == "ok"' "$(check)"
for BAD in '{"items":[{"itemId":"AC2","status":["unsupported"]}]}' '{"items":[null,{"itemId":"AC1","status":"supported"}]}' \
           '{"items":[{"itemId":7,"status":"narrowed"}]}' '{"items":[{"itemId":"AC2"}]}' '{"items":[{"itemId":"AC-2","status":"unsupported"}]}' \
           '{"items":[{"itemId":"AC2","status":"narrowed"}' '{"items":{"AC2":"narrowed"}}' '{"items":[{"itemId":"AC2","status":"unsuported"}]}'; do
  challenger "$BAD"
  expect 7-unreadable-challenger-record '.ok == false and .unruled == [] and .challengerRecord == "unusable" and any(.problems[]; test("acceptance-check.json: unreadable"))' "$(check)"
done
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 adjudication record problem" ] || fail "7-unreadable-sentence: $(report)"
rm -f "$RUN/challenger/acceptance-check.json"; ln -s "$RUN/challenger/gone.json" "$RUN/challenger/acceptance-check.json"
expect 7-dangling-challenger-link '.ok == false and any(.problems[]; test("acceptance-check.json: unreadable"))' "$(check)"
rm -f "$RUN/challenger/acceptance-check.json"
record unsupported
all_met not_met
expect 7-only-a-disputed-met-needs-a-ruling '.unruled == []' "$(check)"
all_met
RAW="$(cat "$RUN/evidence/A1/acceptance-results.json")"
rulings '[{"itemId":"AC2","outcome":"not_met","why":"phone width shows the old rail"}]'
expect 7-ruling-replaces-the-row '.ok == true and .unruled == [] and .outcomes.AC2 == "not_met" and .outcomes.AC1 == "met"' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 ruled not met or unproved" ] || fail "7-not-met-sentence: $(report)"
rulings '[{"itemId":"AC2","outcome":"unproved","why":"the phone width was never reached"}]'
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 ruled not met or unproved" ] || fail "7-unproved-sentence: $(report)"
[ "$(cat "$RUN/evidence/A1/acceptance-results.json")" = "$RAW" ] || fail "7-raw-rows-stay-as-observed"
rulings '[{"itemId":"AC2","outcome":"changed","why":"scope cut"}]'
expect 7-changed-needs-who '.ok == false and any(.problems[]; test("AC2: changed needs decidedBy"))' "$(check)"
rulings '[{"itemId":"AC2","outcome":"changed","why":"scope cut","decidedBy":"carol, example-desk thread"}]'
expect 7-changed '.ok == true and .changed == ["AC2"] and .outcomes.AC2 == "changed"' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 changed" ] || fail "7-changed-sentence: $(report)"
rulings '[{"itemId":"AC2","outcome":"deferred","why":"moved","decidedBy":"carol"}]'
expect 7-deferred-needs-an-issue '.ok == false and any(.problems[]; test("AC2: deferred needs followUp"))' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 adjudication record problem, 1 disputed and unruled" ] || fail "7-invalid-ruling-sentence: $(report)"
rulings '[{"itemId":"AC2","outcome":"deferred","why":"moved","decidedBy":"carol","followUp":"#88"}]'
expect 7-deferred '.ok == true and .deferred == ["#88"] and .outcomes.AC2 == "deferred"' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 deferred (#88)" ] || fail "7-deferred-sentence: $(report)"
rulings '[{"itemId":"AC9","outcome":"met","why":"x"},{"itemId":["AC1"],"outcome":"met","why":"x"},"AC2"]'
expect 7-ruling-for-nothing '.ok == false and ([.problems[] | select(test("unknown item"))] | length) == 3' "$(check)"
rulings '[{"itemId":"AC2","outcome":"met","why":"a"},{"itemId":"AC2","outcome":"not_met","why":"b"}]'
expect 7-one-ruling-per-item '.ok == false and any(.problems[]; test("more than one ruling for AC2"))' "$(check)"
rulings '[{"itemId":"AC2","outcome":"waived","why":"a"}]'
expect 7-unknown-outcome '.ok == false and .unruled == ["AC2"] and any(.problems[]; test("outcome must be one of"))' "$(check)"
rulings '{"itemId":"AC2"}'
expect 7-rulings-not-a-list '.ok == false and any(.problems[]; test("not a JSON list"))' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows, 1 builder claim, 1 adjudication record problem, 1 disputed and unruled" ] || fail "7-unreadable-rulings-sentence: $(report)"
rm -f "$RUN/coordinator/acceptance-rulings.json"; ln -s "$RUN/coordinator/gone.json" "$RUN/coordinator/acceptance-rulings.json"
expect 7-dangling-rulings-link '.ok == false and any(.problems[]; test("not a JSON list"))' "$(check)"
rm -f "$RUN/coordinator/acceptance-rulings.json"

# --- 8. carry-forward ------------------------------------------------------------
# A campaign extracts with --carry-from its baseline run. Whatever that run left
# unresolved (its outcome is not met and not ruled changed) is carried; a later
# met on a carried obligation needs a ruling, and an open one stays on the report.
# Each campaign's own ids differ (real freeze runs prefix them pr<n>/, and their
# ranges are disjoint), so later runs here rename AC* to BC* and CC*.
renamed() { jq --arg p "$1" '.items |= map(.id |= sub("^AC"; $p))' "$EXAMPLE"; }
PRIOR="$WORK/prior"; NEXT="$WORK/next"
RUN="$PRIOR"; new_run; extract >/dev/null; shot a.png; mkdir -p "$RUN/coordinator"
rows "[$(row AC1 met '["evidence/A1/a.png"]'),$(row AC2 not_demonstrable '["evidence/A1/a.png"]' 'no phone build'),$(row AC3 met '["evidence/A1/a.png"]')]"
rulings '[{"itemId":"AC3","outcome":"deferred","why":"cut to a follow-up","decidedBy":"carol","followUp":"#88"}]'
expect 8-prior-ok '.ok == true' "$(check)"
RUN="$NEXT"; new_run "$(renamed BC)"
OUT="$(extract --carry-from "$PRIOR")"
expect 8-carried '.ok == true and .carriedCount == 2' "$OUT"
expect 8-carried-entries '[.carried[] | {id: .item.id, priorOutcome, priorRun, firstRun, followUp, request}] == [
  {id:"AC2", priorOutcome:"not_demonstrable", priorRun:"prior", firstRun:"prior", followUp:null, request:"slack:example-desk/1726000000.000100"},
  {id:"AC3", priorOutcome:"deferred", priorRun:"prior", firstRun:"prior", followUp:"#88", request:"pr-body"}]' "$(cat "$RUN/intent/acceptance.json")"
cp "$RUN/intent/acceptance.json" "$WORK/next-doc.json"
shot a.png; mkdir -p "$RUN/coordinator"
EV='["evidence/A1/a.png"]'
OWN="$(row BC1 met "$EV"),$(row BC2 met "$EV"),$(row BC3 met "$EV")"
# The same obligation, met again with no ruling, is held for adjudication.
rows "[$OWN,$(row AC2 met "$EV"),$(row AC3 met "$EV")]"
expect 8-met-needs-a-ruling '.ok == false and .unruled == ["AC2","AC3"] and .carriedOpen == ["AC2","AC3"]' "$(check)"
rulings '[{"itemId":"AC2","outcome":"met","why":"walked on the phone build"},{"itemId":"AC3","outcome":"changed","why":"scope cut stands","decidedBy":"carol"}]'
expect 8-ruled '.ok == true and .unruled == [] and .carriedOpen == []' "$(check)"
# A carried obligation with no row this campaign is not a missing row; it stays open.
rm -f "$RUN/coordinator/acceptance-rulings.json"
jq '.items |= map(select(.id == "BC1")) | .sources |= {R1}' "$WORK/next-doc.json" > "$WORK/one.json"
cp "$WORK/one.json" "$RUN/intent/acceptance.json"
rows "[$(row BC1 met "$EV")]"
expect 8-open-not-missing '.ok == true and .missingRows == [] and .carriedOpen == ["AC2","AC3"]' "$(check)"
[ "$(report)" = "Acceptance: present(1) — 0 unsupported, 0 missing rows, 2 carried open from earlier campaigns (AC2, AC3)" ] || fail "8-sentence: $(report)"
# The prior run is named by its directory, however --carry-from spells it.
RUN="$WORK/dotted"; new_run "$(renamed BC)"
(cd "$NEXT" && python3 "$TOOL" extract "$RUN" --carry-from . >/dev/null) || true
expect 8-carry-from-dot '[.carried[].priorRun] == ["next","next"]' "$(cat "$RUN/intent/acceptance.json")"
# An open carried obligation carries on, with its first run kept.
THIRD="$WORK/third"; RUN="$THIRD"; new_run "$(renamed CC)"
expect 8-chain '.ok == true and .carriedCount == 2' "$(extract --carry-from "$NEXT")"
expect 8-chain-entries '[.carried[] | {id: .item.id, priorRun, firstRun}] == [{id:"AC2", priorRun:"next", firstRun:"prior"}, {id:"AC3", priorRun:"next", firstRun:"prior"}]' "$(cat "$RUN/intent/acceptance.json")"
# An id this run's items reuse is never merged with or replaced by the carried
# obligation: extract refuses, and a contract holding the clash stops the check.
RUN="$WORK/clash"; new_run
expect 8-clash-refused '.ok == false and (.error | test("reuse carried ids AC2, AC3"))' "$(extract --carry-from "$NEXT")"
[ ! -e "$RUN/intent/acceptance.json" ] || fail "8-clash: a refused carry wrote the contract"
RUN="$NEXT"
jq '.items += [(.carried[0].item | .source = "R1")]' "$WORK/one.json" > "$RUN/intent/acceptance.json"
expect 8-clash-in-doc '.ok == false and .stopped != null and any(.problems[]; test("carried AC2: an item of this run reuses its id"))' "$(check)"
# A malformed carried item is a contract problem, never a crash, and a prior
# holding one refuses the carry because its check stopped.
for edit in 'del(.carried[0].item.then)' '.carried[0].item.source = ["R1"]'; do
  jq "$edit" "$WORK/one.json" > "$NEXT/intent/acceptance.json"
  RUN="$NEXT"
  expect "8-carried-item-checked $edit" '.ok == false and .stopped != null and any(.problems[]; test("carried AC2 item: (then must be an object|source must name a key)"))' "$(check)"
  RUN="$WORK/sixth"; new_run "$(renamed CC)"
  expect "8-malformed-prior-refused $edit" '.ok == false and (.error | test("check stopped"))' "$(extract --carry-from "$NEXT")"
done
cp "$WORK/one.json" "$NEXT/intent/acceptance.json"
# A ruled-changed or met obligation is not carried, and an unreadable prior refuses.
RUN="$WORK/fourth"; new_run
rm -f "$PRIOR/coordinator/acceptance-rulings.json"; rulings_prior() { printf '%s' "$1" > "$PRIOR/coordinator/acceptance-rulings.json"; }
rulings_prior '[{"itemId":"AC2","outcome":"changed","why":"dropped","decidedBy":"carol"},{"itemId":"AC3","outcome":"met","why":"walked"}]'
expect 8-resolved-not-carried '.ok == true and .carriedCount == 0' "$(extract --carry-from "$PRIOR")"
rm -f "$RUN/intent/acceptance.json"
expect 8-unreadable-prior '.ok == false and (.error | test("carry-from"))' "$(extract --carry-from "$WORK/no-such-run")"
[ ! -e "$RUN/intent/acceptance.json" ] || fail "8: a refused carry wrote the contract"
# The carried list is checked like the rest of the contract.
RUN="$NEXT"
jq '.carried[0].priorRun = ""' "$WORK/one.json" > "$RUN/intent/acceptance.json"
expect 8-bad-carried '.ok == false and any(.problems[]; test("carried: every entry"))' "$(check)"
jq '.items[0].id = []' "$WORK/one.json" > "$RUN/intent/acceptance.json"
expect 8-non-text-item-id '.ok == false and .stopped != null and any(.problems[]; test("id must match"))' "$(check)"

echo "smoke-acceptance.test.sh: all sections passed"
