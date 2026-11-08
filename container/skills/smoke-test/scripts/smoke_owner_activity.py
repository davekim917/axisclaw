"""Is a campaign's coordinator owner still writing? The one rule for it.

The owner's liveness is the newest regular-file mtime under <run>/, with two
kinds of write left out because they say nothing about the owner:

* <run>/challenger/, the other side of the campaign in its own session. A
  live challenger must not make a dead owner look alive.
* the files the controller itself writes in <run>/controller/. It rewrites
  barrier-<phase>.json on every fire its barrier refuses, so counting it would
  keep a dead lanes or synthesis owner fresh for as long as the phase lasts.

Directories are not counted: an entry added or removed moves its directory's
mtime, so the one-time mkdir of <run>/challenger/ would bump <run> itself.

A scan that cannot complete can only see fewer files, so its newest mtime can
only fall: an unreadable or symlinked root answers 0, an unreadable subtree is
skipped, and a walk past its time budget stops with what it has seen. Every
failure therefore errs toward "not writing". The budget is checked between
entries, so a slow walk returns what it has seen; it cannot interrupt one
filesystem call that blocks, and a caller that kills the walk on its own
timeout gets no answer, which it must read as "not writing".

CLI, for the shell claim renewer: `smoke_owner_activity.py <run-dir>` prints
the newest owner write in epoch seconds (0 when unknown);
`smoke_owner_activity.py --window` prints OWNER_WRITE_FRESHNESS_SECONDS.
"""
import fnmatch
import os
import sys
import time

# Below about 300 s this window cuts into ordinary owner think-time; a single
# long test command can keep a working owner quiet for longer than it.
OWNER_WRITE_FRESHNESS_SECONDS = 1200
SCAN_BUDGET_SECONDS = 10
CONTROLLER_WRITES = ("barrier-*.json", "brief-*.md", "wake.json", ".*.tmp")


def _controller_wrote(name):
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in CONTROLLER_WRITES)


def newest_owner_write(run_dir, budget=SCAN_BUDGET_SECONDS):
    """Epoch seconds of the newest owner write under run_dir, 0 when unknown."""
    if os.path.islink(run_dir):
        return 0
    deadline = time.monotonic() + budget
    newest = 0.0
    stack = [(run_dir, 0)]
    while stack and time.monotonic() <= deadline:
        path, depth = stack.pop()
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    if time.monotonic() > deadline:
                        break
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not (depth == 0 and entry.name == "challenger"):
                                stack.append((entry.path, depth + 1))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        if depth == 1 and os.path.basename(path) == "controller" and _controller_wrote(entry.name):
                            continue
                        newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
                    except OSError:
                        continue
        except OSError:
            continue
    return int(newest)


def owner_writing(run_dir, now_epoch, window=OWNER_WRITE_FRESHNESS_SECONDS):
    newest = newest_owner_write(run_dir)
    return newest > 0 and now_epoch - newest <= window


def main(argv):
    if argv == ["--window"]:
        print(OWNER_WRITE_FRESHNESS_SECONDS)
        return 0
    if len(argv) != 1:
        print("usage: smoke_owner_activity.py <run-dir> | --window", file=sys.stderr)
        return 2
    print(newest_owner_write(argv[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
