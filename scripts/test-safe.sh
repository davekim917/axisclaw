#!/usr/bin/env bash
# The one supported way to run vitest (or the typed lint) on a host that also runs production:
# one run at a time under a host-wide lock, at idle IO priority and nice 10, on two workers at most.
# Idle priority stalls any test during a host IO burst, so vitest's limits are three times their defaults.
#
#   scripts/test-safe.sh <test files or filters...> [vitest flags]
#   scripts/test-safe.sh lint
#
# File arguments are relative to the repository root. TEST_SAFE_MAX_WORKERS lowers the worker count
# (1 or 2). TEST_SAFE_LOCK moves the lock, for tests of this script only.
set -euo pipefail

die() {
  echo "test-safe: $*" >&2
  exit 2
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
if [ -e "$root/data/v2.db" ]; then
  die "refusing to run in $root: it is an installed host (data/v2.db exists), and a suite there competes with the running service and reads its live state. Run from a worktree: git worktree add <dir> origin/main, then install there."
fi

workers="${TEST_SAFE_MAX_WORKERS:-2}"
case "$workers" in
  1 | 2) ;;
  *) die "TEST_SAFE_MAX_WORKERS must be 1 or 2, got '$workers'" ;;
esac

lock="${TEST_SAFE_LOCK:-/tmp/nanoclaw-vitest.lock}"

if [ "${1:-}" = lint ]; then
  [ "$#" -eq 1 ] || die "'lint' takes no further arguments"
  cmd=(pnpm run lint)
else
  test_timeout=(--testTimeout=15000)
  hook_timeout=(--hookTimeout=30000)
  for arg in "$@"; do
    case "$arg" in
      --maxWorkers* | --max-workers* | --minWorkers* | --min-workers*)
        die "set TEST_SAFE_MAX_WORKERS=1 instead of passing $arg"
        ;;
      # vitest refuses a repeated option rather than taking the last one, so a caller's flag replaces the default.
      --testTimeout* | --test-timeout*) test_timeout=() ;;
      --hookTimeout* | --hook-timeout*) hook_timeout=() ;;
      # vitest.config.ts already scales both further under coverage, and a flag here would lower them.
      --coverage | --coverage.*)
        test_timeout=()
        hook_timeout=()
        ;;
    esac
  done
  # A token after a flag may be that flag's value (--config <path>), so only leading tokens are filters.
  case "${1:--}" in
    -*) die "name the test files you touched first, before any flag; the full suite never runs on this host (it runs nightly, or on demand with: gh workflow run ci-full.yml --ref <branch>)" ;;
  esac
  vitest="$root/node_modules/.bin/vitest"
  [ -x "$vitest" ] || die "$vitest is missing: run 'pnpm install --frozen-lockfile --offline' in this checkout first"
  cmd=("$vitest" run --maxWorkers="$workers" "${test_timeout[@]}" "${hook_timeout[@]}" "$@")
fi

cd "$root"
exec 9>>"$lock"
if ! flock -n 9; then
  echo "test-safe: another run holds $lock; waiting for it to finish" >&2
  flock 9
fi
exec ionice -c3 nice -n 10 "${cmd[@]}"
