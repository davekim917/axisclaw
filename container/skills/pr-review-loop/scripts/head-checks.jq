# What a head's checks read as from Actions, for a token GitHub refuses check
# runs. Fine-grained personal access tokens have no Checks permission at all,
# so such a token gets `commits/<sha>/check-runs` 403 and every CheckRun node of
# a status rollup null beside a FORBIDDEN error; its StatusContext nodes,
# actions/runs, jobs and the branch's rules still answer.

def malformed($what): error("\($what) is not in the expected shape");

def head_runs($head; $labeler; $asof):
  [ .[].workflow_runs[]?
    | select(.head_sha == $head)
    | select($asof == "" or (.created_at // "") <= $asof)
    | select((.name == $labeler and .event == "pull_request_target") | not)
    | if $asof != "" and ((.updated_at // "") as $u | $u == "" or $u > $asof)
      then .status = "updated after the merge" | .conclusion = null else . end ]
  | group_by(.name) | map(
      max_by([.run_started_at // .created_at // "", .id // 0]) as $newest
      | ( [ .[] | select(.event == "pull_request") ] | if length > 0 then [ max_by([.run_started_at // .created_at // "", .id // 0]) ] else [] end ) as $pr
      | [ $newest ] + [ $pr[] | select(.id != $newest.id) ] ) | add // [];

# Whether this required run was cancelled and a later attempt at the same check,
# from $required, then went green. A cancelled run says nothing about the head: a
# `concurrency: cancel-in-progress` workflow cancels one on an ordinary re-trigger,
# and GitHub merges past it. A run that failed is evidence about the head, so
# nothing supersedes it here. `isRequired` alone cannot name a replacement: two
# workflows can report one job name, and each obligation stands. So the same
# check means the same app, workflow and event. Order is by start time, since a
# re-run keeps its run id. Without all of those the run stays red.
def check_identity: [ .checkSuite.app.databaseId, .checkSuite.workflowRun.workflow.databaseId, .checkSuite.workflowRun.event ];
def superseded($required):
  . as $run
  | .conclusion == "CANCELLED"
    and (.startedAt | type) == "string"
    and (check_identity | all(. != null))
    and any($required[]; .__typename == "CheckRun" and .name == $run.name
      and (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED"))
      and check_identity == ($run | check_identity)
      and .startedAt > $run.startedAt);

# A token that reads check runs but not workflow runs gets each run with its
# workflow run null beside an error. Its rollup still answers; superseded only
# has less to go on.
def identity_refused:
  (.errors | type == "array" and length > 0)
  and (.data.repository.pullRequest.statusCheckRollup.contexts.nodes | type == "array")
  and all(.errors[]; .type == "FORBIDDEN"
    and .path[0:5] == ["repository", "pullRequest", "statusCheckRollup", "contexts", "nodes"]
    and .path[6:8] == ["checkSuite", "workflowRun"]);

def contexts_refused:
  .data.repository.pullRequest.statusCheckRollup.contexts.nodes as $nodes
  | ($nodes | type == "array")
    and (.errors | type == "array" and length > 0)
    and all(.errors[]; .type == "FORBIDDEN")
    and ([ .errors[].path ] | sort)
      == ( [ $nodes | to_entries[] | select(.value == null)
             | ["repository", "pullRequest", "statusCheckRollup", "contexts", "nodes", .key] ] | sort );

# An Actions job as the rollup's CheckRun node for it: a job's id is its check
# run's databaseId.
def job_node: {
  __typename: "CheckRun",
  databaseId: .id,
  name,
  status: (.status | ascii_upcase),
  conclusion: (.conclusion | if . == null then null else ascii_upcase end),
  isRequired: true
};

# Slurped actions/runs pages, checked for the fallback; head_runs itself also
# serves ci_verdict, which tolerates a page with no runs.
def checked_runs:
  if type == "array" and all(.[]; (.workflow_runs | type) == "array") then . else malformed("the Actions run listing") end;

# The required checks a base branch declares, as { context, app }, from its
# rules and its classic protection (`repos/<r>/branches/<base>`, which unlike
# `.../protection` needs no admin read).
def declared_checks($rules; $branch):
  ( if ($rules | type) != "array" or any($rules[]; type != "object" or (.type | type) != "string") then malformed("the branch rules") else . end )
  | ( $branch.protection.enabled as $on
      | if $on == true then $branch.protection.required_status_checks
        elif $on == false then { checks: [], contexts: [] }
        else malformed("the branch protection") end
      | if type != "object" or (.checks | type) != "array" or (.contexts | type) != "array" then malformed("the branch protection") else . end ) as $classic
  | [ $rules[] | select(.type == "required_status_checks")
      | .parameters.required_status_checks
      | if type != "array" then malformed("the branch rules") else .[] end
      | { context, app: .integration_id } ]
    + [ $classic.checks[] | { context, app: .app_id } ]
    + [ $classic.contexts[] | { context: ., app: null } ]
  | if any(.[]; (.context | type) != "string" or ((.app | type) | IN("null", "number") | not)) then malformed("a required check") else . end;

# The rollup nodes for a refused page, from the slurped stream [ nodes, rules,
# branch, job listing... ]. A rule pinned to another app is not answered by an
# Actions job of that name. A required name nothing answers for becomes a
# completed check whose conclusion no reader treats as green. RefusedCheckRuns
# stays in the array so admin_readiness can tell: a check run from any other app
# under a required name is invisible here.
def rollup_from_readable($actionsApp):
  .[0] as $nodes | .[1] as $rules | .[2] as $branch
  | [ .[3:][] | .[] | .jobs | if type == "array" then .[] else malformed("a job listing") end ] as $jobs
  | [ $nodes[] | select(. != null) ] as $read
  | declared_checks($rules; $branch) as $checks
  | [ $checks | group_by(.context)[]
      | .[0].context as $name
      | all(.[]; .app == null or .app == $actionsApp) as $jobsCount
      | [ if $jobsCount then $jobs[] | select(.name == $name) | job_node else empty end ] as $ran
      | if ($ran | length) > 0 or any($read[]; (.context // .name) == $name and .isRequired == true) then $ran[]
        else { __typename: "CheckRun", name: $name, status: "COMPLETED", conclusion: "UNREADABLE", isRequired: true } end ] as $derived
  | $read + $derived + [ { __typename: "RefusedCheckRuns" } ];
