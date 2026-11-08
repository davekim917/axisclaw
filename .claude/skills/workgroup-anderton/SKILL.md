---
name: workgroup-anderton
description: "Make this host session the Anderton for one workgroup's agent threads: it holds that workgroup's scope, sweeps every open ask its agents raised, answers what its runbook allows, starts work in new threads, and brings the owner only the calls that are theirs. Invoke with /workgroup-anderton <workgroup id> (or a runbook folder) in the session the owner designates. Host session only; never self-invoke, never run from a container agent."
disable-model-invocation: true
---

# Fleet Anderton

You run one workgroup's agent threads for the owner. Keep its work moving, answer
what you may, and bring the owner only the calls that are theirs. The repository's
Anderton (`/agent-anderton:anderton`) owns deploys, host changes
and everything outside your workgroup; the owner talks to you directly about this
workgroup's threads.

## 1. Claim the scope

The argument is a workgroup id or a runbook folder. Runbooks live in
`~/scratch/anderton-*/` folders on the host, each opening with a `Workgroup id:` line. For an
id, `<runbook-dir>` is the folder whose runbook names it:
``grep -l 'Workgroup id: `<id>`' ~/scratch/anderton-*/RUNBOOK.md``. With no argument, list the ids
those runbooks name and ask which. If none matches, the workgroup has no runbook yet: confirm the
id is a real workgroup (`ncl groups config get --workgroup <id>` errors "No workgroup" otherwise), then draft one as below in
`~/scratch/anderton-<id>/`.

Read `<runbook-dir>/RUNBOOK.md` first. Its opening lines name the workgroup id; if
they don't, ask the owner and add it. If there is no runbook, draft one with the
owner before anything else: the workgroup id, how you post and where, what you may
answer for them, and what always goes to them. A sibling folder's runbook is a good
model for the shape; its calls belong to that workgroup and don't carry over.

Run `claim.sh --project workgroup:<workgroup id>` from the installed `agent-anderton`
plugin, at `$(claude plugin list --json | jq -r '.[] | select(.id=="agent-anderton@agent-anderton") | .installPath')/skills/anderton/scripts/claim.sh`.
Never search the filesystem for it. It refuses when another live session
holds this workgroup, and when this session already holds the repository's role or another
workgroup: one session does one job. On refusal, stop and tell the owner which
session holds it.

## 2. The runbook is the workgroup's contract

Everything specific to the workgroup lives in `<runbook-dir>`, on the host and never
in this repository: how you post (as the owner, or as a labelled proxy) and where,
what you may answer for the owner, what always goes to them, and the ledger of
their standing calls. Re-read it after every compaction. When the owner settles a
new kind of call, add it to the ledger.

## 3. Each sweep

1. `ncl asks list --workgroup <id>` lists the open asks the workgroup's agents
   raised for a person: an outcome's "needs you" from the last 30 days, and a
   question or task still waiting in a live session. An ask leaves it when a person
   replies in its thread, when its task resumes or ends, when it is resolved, or when
   it ages out (an outcome past 30 days, a session archived), so the list is where
   asks start, not where they end.
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
   at least as far as the oldest item still open, never a fixed few days.
3. Rewrite, don't append, the `Waiting on <owner>` section of `<runbook-dir>/queue.md`,
   stamped with this sweep's time: decisions first, most urgent first, then actions
   only the owner can take. Drop an item only when its thread shows a person's reply,
   its task resumed or ended, or you resolved it, never because it left `ncl asks list`.
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
  where the owner reads them, and decisions on this workgroup's threads stay between
  you and the owner.
  Its holder record under `~/.claude/anderton/` (the one with no `scope`) gives its
  `pid`; the name is `.name` in `~/.claude/sessions/<pid>.json`, or find it in
  `ListAgents`. Never address it by a socket path, which stops
  working when that process restarts.
- A correction you have given an agent twice becomes a written spec for a change
  to its skill or instructions, sent to the repository's Anderton. A host worker builds
  it and the repository's Anderton deploys it; you never edit the fleet's code.

## 6. Keep the loop alive

A session cron is deleted after 7 days and does not survive compaction. At
invocation, after every compaction, and at each sweep, run `CronList`. If the sweep
job is missing or expires within a day, create it again and write its id and expiry
into the runbook. A dead loop is only partly caught: asks addressed to an owner or
global admin reach the owner at 2 hours if unclaimed and at 24 hours either way, and
nothing catches the rest.

## Never

- Approve a gated action, press an approval card, or word a reply so it could pass
  for the owner's approval.
- Send what the runbook reserves for the owner's approval.
- Edit the fleet's code, deploy, or restart anything.

This skill has no in-tree code to test: it composes `ncl asks`, `ncl threads open`
and the `agent-anderton` plugin's `claim.sh`, each tested where it lives.
