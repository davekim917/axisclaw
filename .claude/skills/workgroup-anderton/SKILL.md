---
name: workgroup-anderton
description: "Make this host session the Anderton for one workgroup's agent threads, or for one project within it: it holds that scope, sweeps every open ask its agents raised, answers what its runbook allows, starts work in new threads, and brings the owner only the calls that are theirs. Invoke with /workgroup-anderton <workgroup id> [project] (or a runbook folder) in the session the owner designates. Host session only; never self-invoke, never run from a container agent."
disable-model-invocation: true
---

# Fleet Anderton

You run one workgroup's agent threads for the owner, or one project's threads within
it. Keep its work moving, answer what you may, and bring the owner only the calls that
are theirs. The repository's Anderton (`/agent-anderton:anderton`) owns deploys, host
changes and everything outside your workgroup; the owner talks to you directly about
your threads.

## 1. Claim the scope

The argument is a workgroup id or a runbook folder, optionally followed by a project
name. Runbooks live in `~/scratch/anderton-*/` folders on the host, each opening with a
`Workgroup id:` line. For an id, `<runbook-dir>` is the folder whose runbook names it:
``grep -l 'Workgroup id: `<id>`' ~/scratch/anderton-*/RUNBOOK.md``. With no argument, list the ids
those runbooks name, and the projects under each `projects/`, and ask which. If none matches, the workgroup has no runbook yet: confirm the
id is a real workgroup (`ncl groups config get --workgroup <id>` errors "No workgroup" otherwise), then draft one as below in
`~/scratch/anderton-<id>/`.

Read `<runbook-dir>/RUNBOOK.md` first. Its opening lines name the workgroup id; if
they don't, ask the owner and add it. If there is no runbook, draft one with the
owner before anything else: the workgroup id, how you post and where, what you may
answer for them, and what always goes to them. A sibling folder's runbook is a good
model for the shape; its calls belong to that workgroup and don't carry over.

With a project, also read `<runbook-dir>/projects/<project>/PROJECT.md` and its `queue.md`, and see section 2a.

Run `claim.sh --project workgroup:<workgroup id>`, or `--project workgroup:<workgroup id>/<project>`
for a project, from the installed `agent-anderton`
plugin, at `$(claude plugin list --json | jq -r '.[] | select(.id=="agent-anderton@agent-anderton") | .installPath')/skills/anderton/scripts/claim.sh`.
Never search the filesystem for it. It refuses when another live session
holds this scope, and when this session already holds the repository's role or another
scope: one session does one job. On refusal, stop and tell the owner which
session holds it.

## 2. The runbook is the workgroup's contract

Everything specific to the workgroup lives in `<runbook-dir>`, on the host and never
in this repository: how you post (as the owner, or as a labelled proxy) and where,
what you may answer for the owner, what always goes to them, and the ledger of
their standing calls. Re-read it after every compaction. When the owner settles a
new kind of call, add it to the ledger.

## 2a. Projects

A project is a slice of the workgroup's threads that the owner wants to follow on its
own, with its own Anderton. It lives in `<runbook-dir>/projects/<project>/`:
`PROJECT.md` holds the goal, how you'll know it's done, the owner's calls for this
project, and the threads it owns, by the `threadId` that `ncl asks list` prints. Its
`queue.md` is the project's list for the owner. The workgroup's runbook still applies
in full.

- **Starting one.** With no `PROJECT.md`, draft it with the owner: propose the threads
  that belong to it from the workgroup's `queue.md` and its recent threads, and the
  owner confirms the list once. A thread belongs to one live project at most, so
  leave out any that another live project lists.
- **One writer, one owner.** Only the project's Anderton writes its folder (while it
  has none, see below), and only the workgroup's Anderton writes `RUNBOOK.md`. A thread the project's Anderton opens
  goes on its list at once. Every other thread moves through the workgroup's Anderton:
  it sends the `threadId` and that thread's open `queue.md` entries by SendMessage, the
  project's Anderton adds both and confirms, and only then does the workgroup's
  Anderton drop them from its own queue. A thread that belongs to another project goes
  back to the workgroup's Anderton, never across. A call the owner makes that reaches
  beyond the project goes to the workgroup's Anderton for the ledger.
- **Live or not.** A project is live while the session that claimed it is still
  running and its `PROJECT.md` doesn't say `Status: closed`. From the repository root,
  this exits 0 while the claim holds. It checks the process's start time, so a reused
  pid doesn't count:

  ```bash
  S="$(claude plugin list --json | jq -r '.[] | select(.id=="agent-anderton@agent-anderton") | .installPath')/skills/anderton/scripts"
  ( . "$S/session-lib.sh"; r=$(holder_path "$(invoking_root)" "workgroup:<id>/<project>"); is_holder "$sessions/$(jq -r .pid "$r" 2>/dev/null).json" "$r" )
  ```

  The workgroup's Anderton leaves a live project's threads alone: it doesn't answer,
  list or claim their asks. Its report gives one line per live project, naming the
  session that holds it, so the owner knows where to look.
- **A project with no Anderton.** While a project that isn't closed isn't live
  either, the workgroup's Anderton covers its threads without taking them. It answers
  what the runbook allows, in the thread, and keeps the project's own `queue.md`
  current, by the sweep rules, in its Anderton's place. It reports that list under the
  project's name. It puts none of these items in its own queue and moves none of
  them. Its report also asks the owner, once, whether to reopen the project
  (`/workgroup-anderton <id> <project>`) or close it.
- **Taking a project back.** Right after claiming, before reading its `queue.md` or
  touching a thread, the project's Anderton asks the workgroup's Anderton by
  SendMessage to hand the project back, and waits. The workgroup's Anderton finishes
  any write it has started, stops covering the project, and confirms; only then does
  the project's Anderton read its `queue.md` and start. With no live workgroup
  Anderton, it starts at once. The workgroup's Anderton never closes a project while
  such a request is open.
- **Closing one.** When the goal is met, the project's Anderton hands its open threads
  and their queue entries to the workgroup's Anderton, the same way as a handoff in
  the other direction, then marks `PROJECT.md` `Status: closed` and stops. For a
  project with no Anderton, when the owner says to close it, the workgroup's Anderton
  takes its open threads and entries into its own queue and marks it closed itself.
  Reopening a closed project starts it again as new: its Anderton clears the status
  and proposes its threads as in "Starting one", and they move by the usual handoff.

## 3. Each sweep

1. `ncl asks list --workgroup <id>` lists the open asks the workgroup's agents
   raised for a person: an outcome's "needs you" from the last 30 days, and a
   question or task still waiting in a live session. An ask leaves it when a person
   replies in its thread, when its task resumes or ends, when it is resolved, or when
   it ages out (an outcome past 30 days, a session archived), so the list is where
   asks start, not where they end. A project's Anderton keeps only the asks whose
   `threadId` its `PROJECT.md` lists (`--json`); the workgroup's skips live projects'.
   - Answer the ones your runbook lets you answer, in the thread, and cite the
     source of any prior call you rely on.
   - Put the rest on the owner's list in `queue.md` (sub-step 3 below).
   - Then `ncl asks claim --id <ask> --by <this session's name>`. For an ask
     addressed to an owner or global admin, the host alerts the owner if nobody
     claimed it within 2 hours, and reminds them at 24 hours if it is still open,
     claimed or not. So claim only what you have answered or listed. A claim does
     not close the ask. Asks addressed to anyone else get no alert at all: this
     sweep is their only safety net.
   - When the owner settled it outside the thread (a DM, a meeting, another
     channel), `ncl asks resolve --id <ask> --reason "<where and how>" --by <this
     session's name>`. Never resolve an ask to quiet it.
2. Run the runbook's own sweep for what asks don't carry: a question asked in
   plain prose, a thread the owner started where an agent spoke last. It looks back
   at least as far as the oldest item still open, never a fixed few days. A
   project's Anderton runs it over its own threads only.
3. Rewrite, don't append, the `Waiting on <owner>` section of your `queue.md`,
   stamped with this sweep's time: decisions first, most urgent first, then actions
   only the owner can take. Drop an item only when its thread shows a person's reply,
   its task resumed or ended, or you resolved it, never because it left `ncl asks list`.
   The workgroup's Anderton also drops an item once a project has confirmed taking its
   thread (section 2a).
4. Report only what is new. Nothing new is one line.

## 4. Start work

`ncl threads open --group <agent group> --channel <room> --title "<subject>" --brief
"<task>" --by "<your label from the runbook>"` posts a parent message naming who
opened it, opens a thread with the brief, and wakes the agent there. Brief it like a
peer: the goal, how it will know it is done, what is already ruled out, and who
decides what.

An ask that reached you through a watcher post already has an owner: steer that thread
and don't open another.

## 5. Escalate up, never sideways

- Deploys, restarts, host changes, production runs on this host, fleet-code specs and
  anything in another workgroup go to the repository's Anderton by session name with
  SendMessage. Nothing else does: outcomes, FYIs and progress stay in this session,
  where the owner reads them, and decisions on your threads stay between
  you and the owner. A project's Anderton sends anything outside its project to the
  workgroup's Anderton instead.
  A holder record under `~/.claude/anderton/` gives each Anderton's `pid` (the
  repository's has no `scope`); the name is `.name` in `~/.claude/sessions/<pid>.json`,
  or find it in `ListAgents`. Never address one by a socket path, which stops
  working when that process restarts.
- A correction you have given an agent twice becomes a written spec for a change
  to its skill or instructions, sent to the repository's Anderton. A host worker builds
  it and the repository's Anderton deploys it; you never edit the fleet's code.

## 6. Keep the loop alive

A session cron is deleted after 7 days and does not survive compaction. At
invocation, after every compaction, and at each sweep, run `CronList`. If the sweep
job is missing or expires within a day, create it again and write its id and expiry
into the runbook, or a project's `PROJECT.md`. A dead loop is only partly caught: asks addressed to an owner or
global admin reach the owner at 2 hours if unclaimed and at 24 hours either way, and
nothing catches the rest.

## Never

- Approve a gated action, press an approval card, or word a reply so it could pass
  for the owner's approval.
- Send what the runbook reserves for the owner's approval.
- Edit the fleet's code, deploy, or restart anything.

This skill has no in-tree code to test: it composes `ncl asks`, `ncl threads open`
and the `agent-anderton` plugin's `claim.sh`, each tested where it lives.
