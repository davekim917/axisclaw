#!/bin/sh
# Stands in for psql. With the sources footer off it execs the real binary; with it on, the recorder runs it. Either
# way, as from any /bin/sh, an environment variable whose name is not a shell identifier does not reach psql.
# Bun is told to ignore the caller's directory: it would otherwise load a .env from there into psql's environment and
# run a bunfig.toml preload.
ledger="${NANOCLAW_SOURCE_LEDGER:-/tmp/nanoclaw-sources/ledger.jsonl}"
recorder="${NANOCLAW_PSQL_RECORDER:-/app/src/psql-record.ts}"
# Each of these calls gets psql unrecorded: BUN_OPTIONS can make Bun fail before psql starts, and Bun decodes the
# arguments and environment as UTF-8, so a byte that is not (a Latin-1 literal) would reach psql replaced.
utf8() { iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; }
if [ -e "${ledger%/*}/enabled" ] && [ -r "$recorder" ] && [ -z "${BUN_OPTIONS+set}" ] &&
  command -v bun >/dev/null 2>&1 && printf '%s\n' "$@" | utf8 && env | utf8; then
  # The descriptors this shell holds past stderr, which psql would inherit without the recorder in between: a
  # `PGPASSFILE=/dev/fd/3` names one only in the environment. The glob's own directory handle is closed by the time
  # each entry is tested, so it drops out.
  fds=
  for f in /proc/$$/fd/*; do
    n="${f##*/}"
    if [ "$n" -gt 2 ] 2>/dev/null && [ -e "$f" ]; then fds="$fds,$n"; fi
  done
  exec bun --no-env-file --config=/dev/null "$recorder" "--nanoclaw-fds=${fds#,}" "$@"
fi
exec "${NANOCLAW_PSQL_REAL:-/usr/bin/psql}" "$@"
