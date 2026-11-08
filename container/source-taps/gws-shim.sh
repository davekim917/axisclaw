#!/bin/sh
# Stands in for gws. With the sources footer off it execs the real binary untouched; with it on, the recorder runs it.
ledger="${NANOCLAW_SOURCE_LEDGER:-/tmp/nanoclaw-sources/ledger.jsonl}"
if [ -e "${ledger%/*}/enabled" ]; then
  exec node "${NANOCLAW_GWS_RECORDER:-/opt/nanoclaw-sources/gws-record.mjs}" "$@"
fi
exec "${NANOCLAW_GWS_REAL:-/pnpm/gws-real}" "$@"
