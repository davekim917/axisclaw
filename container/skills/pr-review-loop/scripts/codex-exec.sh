#!/usr/bin/env bash
# `codex exec`, rerun once on the next Codex account when the first is at its
# usage limit.
#
#   codex-exec.sh [--prompt-file <file>|-] [--] <codex exec arguments…>
#   codex-exec.sh --start-home [--] [app-server arguments…]
#   codex-exec.sh --check-fallback [--] [codex exec arguments…]
#   codex-exec.sh --real-bin
#   codex-exec.sh --ensure-home
#
# stdout is the final attempt's only (with --json too: a failed attempt's events
# are dropped); stderr ends with `codex-exec: account=<CODEX_HOME> exit=<n>`.
# stdin is closed, because an open stdin makes codex wait for more prompt;
# --prompt-file feeds a file instead, and `--prompt-file -` reads stdin once and
# feeds it to every attempt. A first positional of resume, fork or help, or
# --help/--version, runs codex once, unwrapped, on the stdin it was given: a
# resumed thread lives in one account's home. `review`, exec's other subcommand,
# holds no thread and is wrapped like a prompt.
#
# --start-home prints the CODEX_HOME a long-lived codex (app-server) should start
# on: the current account, unless a codex-exec run found it at its usage limit
# and that mark has not expired, and a fallback passes the hook check below. Nothing runs
# codex exec in that mode.
#
# --check-fallback prints the account a usage limit would move to and exits 0,
# or names each refused account and the hooks it would skip and exits 3 (1 when
# no fallback has an auth.json). Nothing runs codex exec in that mode either.
#
# Accounts: the current one is $CODEX_HOME, else ~/.codex. The rerun uses the
# first of ~/.codex-fallback-<n> (a container's staged fallbacks, in order) or
# ~/.codex-secondary that holds an auth.json and under which codex's hooks/list
# reports every hook it dispatches under the current home. Hook trust is keyed on
# each home's own hooks.json path, and a container stages a fallback as a bare
# credential, so a home can hold the same files and still run without the
# guards. When the only gap is a hook whose handler the fallback holds byte for
# byte but has not trusted, the fallback is trusted for it first (codex-hook-set.mjs
# --sync, through codex's own config write) and the run says so: that trusts
# nothing the current home does not already run. Pass -m explicitly: a fallback
# may carry no config.toml.
#
# A container that defers Codex plugin registration to the first codex call sets
# NANOCLAW_CODEX_REGISTER and leaves CODEX_HOME at a nonexistent sentinel. Every
# mode but --real-bin first runs that registration under a lock (it registers
# once per container; later runs only confirm, and a concurrent first call waits),
# whatever CODEX_HOME names, since every home there only has its plugin hooks once
# it completes. A missing CODEX_HOME becomes the home it prints; a failed
# registration exits 1 without running codex. --ensure-home does only that and
# prints the home, for the codex shim.
#
# Exit: codex's own exit code, or 13 when the last attempt also hit the usage
# limit, when the first hit it after taking an action or left no rollout to
# show it took none (--ephemeral; a rerun could repeat it), or when no usable
# fallback account exists (the same meaning as `codex-review.sh wait` exit 13:
# use a non-Codex frontier reviewer).
set -uo pipefail

prompt_file=""
start_home_only=0
check_fallback_only=0
real_bin_only=0
ensure_home_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file)
      [ $# -ge 2 ] || { echo "codex-exec: --prompt-file needs a file" >&2; exit 2; }
      prompt_file="$2"; shift 2 ;;
    --start-home) start_home_only=1; shift ;;
    --check-fallback) check_fallback_only=1; shift ;;
    --real-bin) real_bin_only=1; shift ;;
    --ensure-home) ensure_home_only=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
if [ -n "$prompt_file" ] && [ "$prompt_file" != - ] && [ ! -r "$prompt_file" ]; then
  echo "codex-exec: cannot read --prompt-file $prompt_file" >&2
  exit 2
fi
# Any checkout's shim carries this line, so a second one on PATH is skipped too.
is_shim() {
  head -c 512 "$1" 2>/dev/null | grep -qF 'nanoclaw-codex-rotation-shim'
}
real_codex() {
  local dir candidate
  if [ -n "${CODEX_REAL_BIN:-}" ] && ! is_shim "$CODEX_REAL_BIN"; then
    printf '%s\n' "$CODEX_REAL_BIN"
    return 0
  fi
  IFS=: read -ra path_dirs <<<"${PATH:-}"
  for dir in "${path_dirs[@]}"; do
    candidate="${dir:-.}/codex"
    [ -f "$candidate" ] && [ -x "$candidate" ] || continue
    is_shim "$candidate" && continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}
if ! codex_bin=$(real_codex); then
  echo "codex-exec: no codex binary on PATH other than a codex-bin/codex shim" >&2
  exit 127
fi
export CODEX_REAL_BIN="$codex_bin"
if [ "$real_bin_only" -eq 1 ]; then
  printf '%s\n' "$codex_bin"
  exit 0
fi

if [ -n "${NANOCLAW_CODEX_REGISTER:-}" ]; then
  if ! registered_home=$(flock -w 900 /tmp/nanoclaw-codex-plugin-registration.lock bun "$NANOCLAW_CODEX_REGISTER") ||
    [ ! -d "$registered_home" ]; then
    echo "codex-exec: codex refused: the deferred Codex plugin registration did not complete (see the error above); CODEX_HOME stays ${CODEX_HOME:-unset}" >&2
    exit 1
  fi
  [ -d "${CODEX_HOME:-/nonexistent}" ] || export CODEX_HOME="$registered_home"
fi
if [ "$ensure_home_only" -eq 1 ]; then
  printf '%s\n' "${CODEX_HOME:-}"
  exit 0
fi

# codex prints a failed turn as `ERROR: <message>` on stderr and exits 1; the
# prompt is echoed to stderr too, so only an ERROR line counts. Under --json the
# failure is a `turn.failed` event on stdout instead, whose only text is the
# error. Every usage-limit sentence in the codex CLI starts "You've hit your
# usage limit".
usage_limited() {
  sed $'s/\x1b\\[[0-9;]*m//g' "$work/err" | grep -q -E '^ERROR: .*hit your usage limit' ||
    grep -q -E '^\{"type":"turn\.failed",.*hit your usage limit' "$work/out"
}

# A mark lasts until the usage-limit message's "try again at" time, at most a
# week, else an hour: the same rule as the host's Codex account marks.
mark_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codex-exec/exhausted"
mark_file() {
  local real
  real=$(readlink -f "$1") || real="$1"
  printf '%s/%s\n' "$mark_dir" "$(printf '%s' "$real" | tr '/' '%')"
}
# Only the failure itself: the last `ERROR:` usage-limit line, or a turn.failed
# event's message. A prompt quoting an older limit message is echoed earlier.
limit_reset_epoch() {
  local js
  js=$(command -v node || command -v bun) || return 1
  [ -f "$work/reset.cjs" ] || cat >"$work/reset.cjs" <<'JS'
const fs = require('fs');
const [errFile, outFile] = process.argv.slice(2);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const errors = strip(fs.readFileSync(errFile, 'utf8'))
  .split('\n')
  .filter((l) => /^ERROR: .*hit your usage limit/.test(l));
const failed = fs
  .readFileSync(outFile, 'utf8')
  .split('\n')
  .flatMap((l) => {
    if (!l.startsWith('{"type":"turn.failed"')) return [];
    try {
      const msg = JSON.parse(l).error?.message;
      return typeof msg === 'string' && msg.includes('hit your usage limit') ? [msg] : [];
    } catch {
      return [];
    }
  });
const text = failed.at(-1) ?? errors.at(-1) ?? '';
// codex prints local time, with the date only when the reset falls on a later day.
const dated = /try again at ([A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}(?::\d{2})? ?(?:AM|PM)?)/i.exec(text);
const timeOnly = /try again at (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)\b/i.exec(text);
let at = NaN;
if (dated) {
  at = Date.parse(dated[1].replace(/(\d)(st|nd|rd|th)/i, '$1'));
} else if (timeOnly) {
  const day = new Date();
  const hour = (Number(timeOnly[1]) % 12) + (/pm/i.test(timeOnly[4]) ? 12 : 0);
  day.setHours(hour, Number(timeOnly[2]), Number(timeOnly[3] ?? 0), 0);
  at = day.getTime();
}
const now = Date.now();
if (!Number.isFinite(at) || at <= now) process.exit(1);
console.log(Math.floor(Math.min(at, now + 7 * 24 * 60 * 60 * 1000) / 1000));
JS
  "$js" "$work/reset.cjs" "$work/err" "$work/out"
}
mark_exhausted() {
  local file until
  file=$(mark_file "$1")
  until=$(limit_reset_epoch 2>/dev/null) || until=$(($(date +%s) + 3600))
  mkdir -p "$mark_dir" 2>/dev/null && echo "$until" >"$file.$$" 2>/dev/null && mv -f "$file.$$" "$file"
  return 0
}
is_exhausted() {
  local until
  until=$(cat "$(mark_file "$1")" 2>/dev/null) || return 1
  [[ "$until" =~ ^[0-9]+$ ]] && [ "$until" -gt "$(date +%s)" ]
}

# codex runs as a tracked child, not inside a pipeline, so a signal sent to this
# script's pid (a caller's timeout or kill) reaches it instead of orphaning it.
child=""
forward_signal() {
  [ -n "$child" ] && kill -s "$1" "$child" 2>/dev/null && wait "$child" 2>/dev/null
  exit "$2"
}
trap 'forward_signal TERM 143' TERM
trap 'forward_signal INT 130' INT
trap 'forward_signal HUP 129' HUP

attempt() {
  local home="$1" stdin_src=/dev/null rc tee_pid
  shift
  [ -n "$prompt_file" ] && stdin_src="$prompt_file"
  rm -f "$work/err.pipe" && mkfifo "$work/err.pipe" || return 1
  tee "$work/err" <"$work/err.pipe" >&2 &
  tee_pid=$!
  # The FIFO opens first, so a failing redirect after it still releases tee.
  CODEX_HOME="$home" "$codex_bin" exec "$@" 2>"$work/err.pipe" <"$stdin_src" >"$work/out" &
  child=$!
  wait "$child"
  rc=$?
  child=""
  wait "$tee_pid"
  return "$rc"
}

probe_args=()
probe_reproducible=1
passthrough=0
json=0
ephemeral=0
scan_args() {
  local positional=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --) return 0 ;;
      -h|--help|-V|--version) passthrough=1; return 0 ;;
      -c|--config|--enable|--disable)
        [ $# -ge 2 ] || { probe_reproducible=0; return 0; }
        probe_args+=("$1" "$2"); shift 2 ;;
      --config=*|--enable=*|--disable=*|--strict-config) probe_args+=("$1"); shift ;;
      -m|--model|-s|--sandbox|-i|--image|-o|--output-last-message|--output-schema|--color)
        [ $# -ge 2 ] || { probe_reproducible=0; return 0; }
        shift 2 ;;
      --json) json=1; shift ;;
      # `exec review` picks its diff with these; they select input, not hooks.
      --uncommitted) shift ;;
      --base|--commit|--title)
        [ $# -ge 2 ] || { probe_reproducible=0; return 0; }
        shift 2 ;;
      --base=*|--commit=*|--title=*) shift ;;
      --ephemeral) ephemeral=1; shift ;;
      --model=*|--sandbox=*|--image=*|--output-last-message=*|--output-schema=*|--color=*|--skip-git-repo-check) shift ;;
      # Sandbox and approvals only; codex 0.163's hook dispatch never reads them.
      --yolo|--dangerously-bypass-approvals-and-sandbox) shift ;;
      # codex 0.163 runs no user or plugin hook under it (their trust lives in the
      # ignored config.toml), so the probe's full-config sets are a stricter check.
      --ignore-user-config) shift ;;
      -p|--profile|-C|--cd|--add-dir|--local-provider|--thread-source|--cyber-access-program)
        probe_reproducible=0
        [ $# -ge 2 ] || return 0
        shift 2 ;;
      -) positional=1; shift ;;
      -*) probe_reproducible=0; shift ;;
      *)
        if [ "$positional" -eq 0 ]; then
          case "$1" in resume|fork|help) passthrough=1; return 0 ;; esac
        fi
        positional=1; shift ;;
    esac
  done
}
scan_args "$@"

if [ "$passthrough" -eq 1 ] && [ "$start_home_only" -eq 0 ] && [ "$check_fallback_only" -eq 0 ]; then
  if [ -n "$prompt_file" ] && [ "$prompt_file" != - ]; then
    exec "$codex_bin" exec "$@" <"$prompt_file"
  fi
  exec "$codex_bin" exec "$@"
fi

work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT

# A rerun replays the whole prompt, so it follows only an attempt that took no
# action, judged from codex's rollouts: the --json event stream leaves out some
# commands that ran (one whose failure codex reads as a sandbox denial). Each
# line is parsed, never text-matched, since a call's arguments can hold
# anything. Every response_item whose own type is not inert counts, whatever the
# sandbox (MCP servers and sub-agents act outside it), and so does a line that
# does not parse. A review or a sub-agent writes its own rollout, whose
# session_meta names the parent session. No rollout naming the session means
# no record, and no rerun.
cat >"$work/actions.cjs" <<'JS'
const fs = require('fs');
const [id, ...files] = process.argv.slice(2);
const inert = (t) => ['message', 'reasoning', 'agent_message', 'web_search_call'].includes(t) || /_output$/.test(t);
let matched = 0;
let acted = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  });
  const meta = lines.find((e) => e?.type === 'session_meta');
  if (!meta || (meta.payload?.id !== id && meta.payload?.session_id !== id)) continue;
  matched++;
  acted += lines.filter((e) => e === null || (e.type === 'response_item' && !inert(e.payload?.type))).length;
}
if (matched === 0) process.exit(2);
console.log(acted);
JS
attempt_actions() {
  local js id count
  local rollouts=()
  [ "$ephemeral" -eq 0 ] || { echo unknown; return; }
  js=$(command -v node || command -v bun) || { echo unknown; return; }
  if [ "$json" -eq 1 ]; then
    id=$(sed -n -E 's/^\{"type":"thread\.started","thread_id":"([0-9a-f-]{36})".*/\1/p' "$work/out" | head -1)
  else
    id=$(sed $'s/\x1b\\[[0-9;]*m//g' "$work/err" | sed -n -E 's/^session id: ([0-9a-f-]{36})$/\1/p' | head -1)
  fi
  [ -n "$id" ] || { echo unknown; return; }
  mapfile -d '' rollouts < <(find "$1/sessions/" -name 'rollout-*.jsonl' -newer "$work/start" -print0 2>/dev/null)
  if count=$("$js" "$work/actions.cjs" "$id" "${rollouts[@]}" 2>/dev/null); then
    echo "$count"
  else
    echo unknown
  fi
}

if [ "$prompt_file" = - ]; then
  cat >"$work/prompt" || exit 1
  prompt_file="$work/prompt"
fi

hook_set() {
  local js
  [ "$probe_reproducible" -eq 1 ] || return 1
  js=$(command -v node || command -v bun) || return 1
  "$js" "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/codex-hook-set.mjs" "$@" "${probe_args[@]}"
}

missing_hooks() {
  LC_ALL=C comm -23 <(printf '%s\n' "$1" | sed '/^$/d' | LC_ALL=C sort) <(printf '%s\n' "$2" | sed '/^$/d' | LC_ALL=C sort)
}

same_guard_chain() {
  local current_hooks candidate_hooks home="" missing synced
  if [ "$probe_reproducible" -ne 1 ]; then
    echo "codex-exec: these codex arguments change which hooks run in a way the hook check cannot reproduce, so no fallback account is used" >&2
    return 1
  fi
  current_hooks=$(hook_set "$1") || home="$1"
  [ -z "${home:-}" ] && { candidate_hooks=$(hook_set "$2") || home="$2"; }
  if [ -n "${home:-}" ]; then
    echo "codex-exec: could not list the hooks codex runs under $home, so $2 is not used as a fallback" >&2
    return 1
  fi
  missing=$(missing_hooks "$current_hooks" "$candidate_hooks")
  [ -z "$missing" ] && return 0
  if synced=$(hook_set --sync "$1" "$2") && [ -n "$synced" ]; then
    {
      echo "codex-exec: HOOK TRUST SYNCED: trusted these hooks under $2, as $1 already does with the same handler:"
      printf '%s\n' "$synced" | sed 's/^/codex-exec:   /'
    } >&2
    candidate_hooks=$(hook_set "$2") || candidate_hooks=""
    missing=$(missing_hooks "$current_hooks" "$candidate_hooks")
    [ -z "$missing" ] && return 0
  fi
  {
    echo "codex-exec: HOOK TRUST DRIFT: $2 would not run these hooks that $1 runs, so it is not used as a fallback:"
    printf '%s\n' "$missing" | cut -f1,2 | sed 's/^/codex-exec:   /'
    echo "codex-exec: re-trust them under $2 (its config.toml hooks.state, keyed on its own hooks.json path) to restore rotation"
  } >&2
  return 1
}

fallback_home() {
  local current="$1" skip_exhausted="${2:-0}" candidate n=1 unguarded=0
  local candidates=()
  while [ -d "$HOME/.codex-fallback-$n" ]; do
    candidates+=("$HOME/.codex-fallback-$n")
    n=$((n + 1))
  done
  candidates+=("$HOME/.codex-secondary")
  for candidate in "${candidates[@]}"; do
    [ ! "$candidate" -ef "$current" ] && [ -f "$candidate/auth.json" ] || continue
    [ "$skip_exhausted" -eq 1 ] && is_exhausted "$candidate" && continue
    if ! same_guard_chain "$current" "$candidate"; then
      unguarded=1
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  [ "$unguarded" -eq 1 ] && return 3
  return 1
}

finish() {
  cat "$work/out"
  echo "codex-exec: account=$1 exit=$2" >&2
  exit "$2"
}

current="${CODEX_HOME:-$HOME/.codex}"

if [ "$check_fallback_only" -eq 1 ]; then
  fallback_home "$current"
  exit $?
fi

if [ "$start_home_only" -eq 1 ]; then
  if is_exhausted "$current" && next=$(fallback_home "$current" 1); then
    printf '%s\n' "$next"
  else
    printf '%s\n' "$current"
  fi
  exit 0
fi

: >"$work/start"
attempt "$current" "$@"
rc=$?
if [ "$rc" -eq 0 ] || ! usage_limited; then
  finish "$current" "$rc"
fi
mark_exhausted "$current"
actions=$(attempt_actions "$current")
if [ "$actions" != 0 ]; then
  if [ "$actions" = unknown ]; then
    actions="an unknown number of actions (no rollout of this session could be read; an --ephemeral run leaves none)"
  else
    actions="$actions action(s)"
  fi
  echo "codex-exec: $current hit its Codex usage limit mid-run after $actions; nothing was rerun, so no command, edit or tool call repeats on another account. Resume or redo the task by hand" >&2
  finish "$current" 13
fi
next=$(fallback_home "$current")
case $? in
  0) ;;
  3)
    echo "codex-exec: $current hit its Codex usage limit; no fallback account here is confirmed to dispatch every hook $current does, so none is used; use a non-Codex frontier reviewer" >&2
    finish "$current" 13 ;;
  *)
    echo "codex-exec: $current hit its Codex usage limit and no fallback account has an auth.json (~/.codex-fallback-<n>, ~/.codex-secondary); use a non-Codex frontier reviewer" >&2
    finish "$current" 13 ;;
esac
echo "codex-exec: $current hit its Codex usage limit; rerunning once with CODEX_HOME=$next" >&2
attempt "$next" "$@"
rc=$?
if [ "$rc" -ne 0 ] && usage_limited; then
  mark_exhausted "$next"
  echo "codex-exec: $current and $next are both at their Codex usage limit; use a non-Codex frontier reviewer" >&2
  finish "$next" 13
fi
finish "$next" "$rc"
