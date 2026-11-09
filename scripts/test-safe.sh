#!/usr/bin/env bash
# The one supported way to run vitest (or the typed lint) on a host that also runs production:
# one run at a time under a host-wide lock, at idle IO priority and nice 10, on two workers at most.
# Idle priority stalls any test during a host IO burst, so vitest's limits are three times their defaults.
#
#   scripts/test-safe.sh <test files or filters...> [vitest flags]
#   scripts/test-safe.sh changed [vitest flags]
#   scripts/test-safe.sh lint
#
# File arguments are relative to the repository root, and each must match a test file. `changed` runs
# the tests that import a file this branch changed since origin/main, committed or not. TEST_SAFE_MAX_WORKERS
# lowers the worker count (1 or 2). TEST_SAFE_LOCK moves the lock, for tests of this script only.
set -euo pipefail

die() {
  echo "test-safe: $*" >&2
  exit 2
}

full_suite="the full suite never runs on this host (it runs nightly, or on demand with: gh workflow run ci-full.yml --ref <branch>)"

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
throttle=(ionice -c3 nice -n 10)

mode=files
case "${1:-}" in
  lint)
    [ "$#" -eq 1 ] || die "'lint' takes no further arguments"
    mode=lint
    ;;
  changed)
    shift
    mode=changed
    ;;
esac

if [ "$mode" = lint ]; then
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
  if [ "$mode" = files ]; then
    # A token after a flag may be that flag's value (--config <path>), so only leading tokens are filters.
    case "${1:--}" in
      -*) die "name the test files you touched first, before any flag, or run 'changed'; $full_suite" ;;
    esac
  fi
  vitest="$root/node_modules/.bin/vitest"
  [ -x "$vitest" ] || die "$vitest is missing: run 'pnpm install --frozen-lockfile --offline' in this checkout first"
  run=("$vitest" run --maxWorkers="$workers" "${test_timeout[@]}" "${hook_timeout[@]}")
fi

cd "$root"
exec 9>>"$lock"
if ! flock -n 9; then
  echo "test-safe: another run holds $lock; waiting for it to finish" >&2
  flock 9
fi

list() {
  "${throttle[@]}" "$vitest" list --filesOnly "$@"
}

if [ "$mode" = files ]; then
  # vitest runs whatever the other names match and passes, so a mistyped path would drop its tests silently.
  unmatched=()
  for arg in "$@"; do
    case "$arg" in -*) break ;; esac
    found=$(list "$arg") || die "vitest could not list the test files for '$arg'"
    [ -n "$found" ] || unmatched+=("$arg")
  done
  [ "${#unmatched[@]}" -eq 0 ] || die "these names match no test file: ${unmatched[*]}"
  cmd=("${run[@]}" "$@")
elif [ "$mode" = changed ]; then
  git rev-parse --verify -q origin/main >/dev/null || die "'changed' compares with origin/main, which this checkout lacks: git fetch origin main"
  selected=$(list --changed=origin/main) || die "vitest could not list the tests for the changed files"
  if [ -z "$selected" ]; then
    echo "test-safe: no host test imports a file this branch changed" >&2
    exit 0
  fi
  all=$(list) || die "vitest could not list the test files"
  # vitest selects every test when a package.json, its config or a setup file changed.
  [ "$(wc -l <<<"$selected")" -lt "$(wc -l <<<"$all")" ] || die "the changed files reach every host test; $full_suite"
  mapfile -t files <<<"$selected"
  echo "test-safe: running the ${#files[@]} test files that import a changed file" >&2
  cmd=("${run[@]}" "${files[@]}" "$@")
fi

exec "${throttle[@]}" "${cmd[@]}"
