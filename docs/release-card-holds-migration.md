# Warning cards name the holds their Go accepts

A `request_choice` warning card (`approvalScope` with `decision.kind: "warning"`) must now carry `approvalScope.holds`: the exact `hold:` codes the release policy published for the pinned head. The host shows them on the card ("Ship accepts only these holds, at this head") and writes them, sorted, into the click receipt (`choice_receipts.release_scope_json`, and `release_scope=` on the `choice_response`). This page is the migration path for an agent group that posts warning cards. Hand it to the coding agent as is.

## Why

Before this change the receipt named only the repository, PR, base and head. A release policy then had to infer which holds the clicker had seen from when each one was published, and that inference let a Go cover a hold the card never showed. A receipt that names the holds removes the inference: a Go covers exactly what the card displayed, at exactly that head.

## 1. Detect

In the session of any group that posts warning cards, look for either refusal:

- `request_choice failed: a warning card needs approvalScope.holds: the exact hold codes its Go accepts` (host or runner): the card omitted `holds`, or passed an empty list.
- `request_choice failed: approvalScope is malformed`: `holds` repeats a code, has more than 24, or holds something other than a `hold:` code of letters, digits and `_ . : / @ + -`.

A warning card that was still open when the host deployed has no `holds`. Its click now carries no `release_scope`, so it never counts as a release decision.

## 2. Fix

1. In the group's procedure, pass the PR's published `hold:` codes as `approvalScope.holds` on every warning card. Use the codes as the policy published them on the PR's `Release approval` status at that head, never `wait:` codes. A release card may omit `holds`; it then shows "Ship accepts no holds".
2. `ncl groups restart --id <group>`, so the container's runner snapshot takes the new schema.
3. Re-post any warning card that was open before the deploy, under its existing `key`. That closes the old card.

## 3. Verify

- The next warning card lists its holds directly above the "Pinned to …" line.
- After a click, the `choice_response` line's decoded `release_scope` ends in `"holds":[…]` with the same codes, sorted.

## 4. Rollback

1. First retire every warning card still open that was posted without `holds` (re-post that PR's card under its `key`, which closes the old one, or let it be answered). The reverted host reads such a card as scoped again, so a click on it after the revert would count.
2. Revert the change and redeploy. A card posted with `holds` then carries no release scope, because the reverted host refuses a scope with a sixth key, so its click never counts.
3. Restore the procedure's old card shape and re-post any warning card that is still open.
