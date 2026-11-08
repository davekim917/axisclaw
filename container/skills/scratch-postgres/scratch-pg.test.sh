#!/usr/bin/env bash
# scratch-pg against a real throwaway cluster: start is idempotent, clients connect only after the locality proof,
# only the non-superuser login role gets in and the server refuses it anything that reaches another server, and a
# non-postgres listener on the recorded port is refused. Needs Postgres server binaries (the agent image has
# them). With GUARD_CORE set to the destructive-command guard's block-destructive-core.ts, the command line the
# script runs is also put through the guard's own scratch-Postgres exemption, against this machine's procfs.
#
# Run: bash container/skills/scratch-postgres/scratch-pg.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPG="$SCRIPT_DIR/scratch-pg"
export SCRATCH_PG_ROOT
SCRATCH_PG_ROOT="$(mktemp -d /tmp/scratch-pg-test.XXXXXX)"
PORT=$((20000 + RANDOM % 20000))
LISTENER=""
cleanup() {
  [[ -n "$LISTENER" ]] && kill "$LISTENER" 2>/dev/null || true
  bash "$SPG" stop >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_PG_ROOT"
}
trap cleanup EXIT

if ! ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1 && [[ -z "${SCRATCH_PG_BIN:-}" ]]; then
  echo "SKIP: no Postgres server binaries on this machine" >&2
  exit 0
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
refuses() {
  local want="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then fail "expected refusal ($want) from: $*"; fi
  [[ "$out" == *"$want"* ]] || fail "refusal for '$*' was '$out', expected '$want'"
}
guard() {
  [[ -n "${GUARD_CORE:-}" ]] || return 0
  bun -e "
    const { evaluateBashCommand } = await import(process.env.GUARD_CORE);
    console.log(evaluateBashCommand(process.argv[1], { cwd: '/tmp' }).action);
  " "$1" 2>/dev/null
}

# 1. Start brings up a cluster under /tmp on 127.0.0.1; a second start is a no-op on the same postmaster.
bash "$SPG" start --port "$PORT" | grep -q "running on 127.0.0.1:$PORT" || fail "start"
pid="$(sed -n 1p "$SCRATCH_PG_ROOT/data/postmaster.pid")"
bash "$SPG" start | grep -q "already running on 127.0.0.1:$PORT" || fail "second start not a no-op"
[[ "$(sed -n 1p "$SCRATCH_PG_ROOT/data/postmaster.pid")" == "$pid" ]] || fail "second start restarted postgres"

# 2. Clients reach it.
[[ "$(bash "$SPG" psql postgres -qtA -c 'select 40 + 2')" == 42 ]] || fail "psql"
bash "$SPG" createdb app_test
[[ "$(bash "$SPG" psql app_test -qtA -c "select pg_encoding_to_char(encoding) || ' ' || datcollate from pg_database where datname = current_database()")" == 'UTF8 C.UTF-8' ]] ||
  fail "databases are not UTF8"
[[ "$(bash "$SPG" psql app_test -qtA -c "select octet_length(chr(233))")" == 2 ]] || fail "UTF-8 text"
[[ "$(bash "$SPG" psql app_test -qtA -c 'select current_database()')" == app_test ]] || fail "createdb"
bash "$SPG" dropdb app_test
refuses 'does not exist' bash "$SPG" psql app_test -c 'select 1'
[[ "$(bash "$SPG" url app_test)" == "postgresql://scratch@127.0.0.1:$PORT/app_test" ]] || fail "url"

# 3. What it runs is the exact form the guard exempts, with the libpq redirects cleared.
line="$(SCRATCH_PG_DRY_RUN=1 bash "$SPG" psql postgres -c 'drop table if exists t')"
[[ "$line" =~ ^/[^\ ]*/psql\ -X\ -h\ 127\.0\.0\.1\ -p\ $PORT\ -U\ scratch\ -d\ postgres\ -c\ \'drop\ table\ if\ exists\ t\'\ ?$ ]] ||
  fail "command line was: $line"
[[ "$(PGHOST=db.example.com PGSERVICE=prod PGOPTIONS=-csearch_path=x bash "$SPG" psql postgres -qtA -c 'show search_path')" == '"$user", public' ]] ||
  fail "libpq environment reached psql"
if [[ -n "${GUARD_CORE:-}" ]]; then
  [[ "$(guard "$line")" == allow ]] || fail "the guard does not exempt: $line"
fi

# 4. Arguments that could move the connection, or SQL the guard can't read, are refused before anything runs.
refuses 'must be under /tmp' env SCRATCH_PG_ROOT=/var/lib/pg bash "$SPG" start
refuses 'database name' bash "$SPG" psql 'postgresql://db.example.com/app' -c 'select 1'
refuses 'not allowed here' bash "$SPG" psql postgres -h db.example.com -c 'select 1'
refuses 'not allowed here' bash "$SPG" psql postgres -p 5432 -c 'select 1'
refuses 'not allowed here' bash "$SPG" psql postgres -hdb.example.com -c 'select 1'
refuses 'not allowed here' bash "$SPG" psql postgres -f /tmp/x.sql
refuses 'backslash' bash "$SPG" psql postgres -c '\c "host=db.example.com dbname=app"'
refuses 'unexpected argument' bash "$SPG" psql postgres "host=db.example.com" -c 'select 1'
refuses 'give the SQL with -c' bash "$SPG" psql postgres
refuses 'only a database name' bash "$SPG" dropdb app_test -h db.example.com

# 5. The server bounds the SQL: only the scratch role logs in, and it can't reach another server or the host,
# however the SQL is put together.
PSQL="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)/psql"
for user in scratch_admin postgres; do
  refuses 'pg_hba.conf rejects connection' "$PSQL" -X -h 127.0.0.1 -p "$PORT" -U "$user" -d postgres -c 'select 1'
  refuses 'pg_hba.conf rejects connection' "$PSQL" -X -h "$SCRATCH_PG_ROOT/sock" -p "$PORT" -U "$user" -d postgres -c 'select 1'
done
refuses 'permission denied to create extension "dblink"' bash "$SPG" psql postgres -c 'create extension dblink'
refuses 'permission denied to create extension "postgres_fdw"' bash "$SPG" psql postgres -c 'create extension postgres_fdw'
for sql in "COPY (SELECT 1) TO PROGRAM 'curl https://db.example.com'" \
  "DO \$\$ BEGIN EXECUTE 'CO' || 'PY (SELECT 1) TO PRO' || 'GRAM ''curl https://db.example.com'''; END \$\$"; do
  refuses 'pg_execute_server_program' bash "$SPG" psql postgres -c "$sql"
done
refuses 'permission denied for function lo_import' bash "$SPG" psql postgres -c "select lo_import('/etc/passwd')"
refuses 'must be superuser' bash "$SPG" psql postgres -c 'alter role scratch superuser'
refuses 'must be superuser to create superusers' bash "$SPG" psql postgres -c 'create role other superuser'

# 6. --role names the login role a test harness expects; it is still not a superuser, and the harness's own drop goes
# through without approval.
ROLE_ROOT="$(mktemp -d /tmp/scratch-pg-role.XXXXXX)"
ROLE_PORT=$((PORT + 1))
refuses 'setup superuser' env SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start --role scratch_admin
refuses 'lowercase letters' env SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start --role 'x;drop'
for word in all sameuser samerole replication public none; do
  refuses 'reserved word in pg_hba.conf' env SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start --role "$word"
done
refuses 'starting with pg_' env SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start --role pg_harness
SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start --port "$ROLE_PORT" --role harness_user | grep -q "role harness_user" || fail "start --role"
refuses 'set up for role harness_user' env SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start --role other
SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" createdb x_test
[[ "$("$PSQL" -X -qtA -h 127.0.0.1 -p "$ROLE_PORT" -U harness_user -d postgres -c 'select rolsuper from pg_roles where rolname = current_user')" == f ]] ||
  fail "--role is a superuser"
drop="$PSQL -X -h 127.0.0.1 -p $ROLE_PORT -U harness_user -d postgres -c 'DROP DATABASE x_test'"
if [[ -n "${GUARD_CORE:-}" ]]; then
  [[ "$(guard "$drop")" == allow ]] || fail "the guard does not exempt the harness drop: $drop"
fi
eval "$drop" >/dev/null || fail "harness drop"
SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" stop >/dev/null
echo 'host all scratch_admin 127.0.0.1/32 trust' >>"$ROLE_ROOT/data/pg_hba.conf"
refuses 'was not set up by scratch-pg for role harness_user' env SCRATCH_PG_ROOT="$ROLE_ROOT" bash "$SPG" start
rm -rf "$ROLE_ROOT"

# --extra-role makes roles a migration expects to find, with no login and no privileges; :member lets the login
# role SET ROLE to one. The login role still can't grant itself a predefined role.
EXTRA_ROOT="$(mktemp -d /tmp/scratch-pg-extra.XXXXXX)"
EXTRA_PORT=$((PORT + 3))
refuses 'starting with pg_' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start --extra-role pg_x
refuses 'reserved word in pg_hba.conf' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start --extra-role all:member
refuses 'lowercase letters' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start --extra-role x:owner
refuses 'is the login role' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start --role app_user --extra-role app_user
SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start --port "$EXTRA_PORT" --role app_user --extra-role prov_role --extra-role prov_owner:member >/dev/null ||
  fail "start --extra-role"
xq() { SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" psql postgres -qtA -c "$1"; }
[[ "$(xq "select string_agg(rolname || ':' || (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls)::text, ',' order by rolname) from pg_roles where rolname like 'prov_%'")" == 'prov_owner:false,prov_role:false' ]] ||
  fail "extra roles' attributes"
# A migration's idempotent check: create the role only if missing, else require exactly these attributes.
xq "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prov_owner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) THEN RAISE EXCEPTION 'prov_owner missing or wrong'; END IF; END \$\$" >/dev/null ||
  fail "a migration's role check"
[[ "$(xq 'set role prov_owner; select current_user')" == prov_owner ]] || fail ":member does not allow SET ROLE"
refuses 'permission denied to set role' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" psql postgres -c 'set role prov_role'
refuses 'must have admin option on role "pg_execute_server_program"' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" psql postgres -c 'grant pg_execute_server_program to app_user'
refuses 'must have admin option on role "pg_execute_server_program"' env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" psql postgres -c 'set role prov_owner; grant pg_execute_server_program to prov_owner'
SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start | grep -q 'already running' || fail "restart with recorded extra roles"
refuses "set up with extra roles 'prov_role,prov_owner:member'" env SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" start --extra-role other
SCRATCH_PG_ROOT="$EXTRA_ROOT" bash "$SPG" stop >/dev/null
rm -rf "$EXTRA_ROOT"

# A data directory scratch-pg didn't make, whatever roles and extensions it holds, is refused rather than adopted;
# so is its own one after pg_hba.conf was edited. A cluster from before the role existed is told to start over.
SUPER_ROOT="$(mktemp -d /tmp/scratch-pg-super.XXXXXX)"
"$(dirname "$PSQL")/initdb" -D "$SUPER_ROOT/data" -U scratch_admin --auth=trust >/dev/null
"$(dirname "$PSQL")/pg_ctl" -D "$SUPER_ROOT/data" -o "-p $((PORT + 2)) -k $SUPER_ROOT -c listen_addresses=127.0.0.1" -w start >/dev/null
"$PSQL" -X -q -h "$SUPER_ROOT" -p $((PORT + 2)) -U scratch_admin -d postgres -c 'create role harness_user superuser login'
# A test harness's own cluster under /tmp, with a superuser login: the same drop gets no exemption.
if [[ -n "${GUARD_CORE:-}" ]]; then
  [[ "$(guard "$PSQL -X -h 127.0.0.1 -p $((PORT + 2)) -U harness_user -d postgres -c 'DROP DATABASE x_test'")" == block ]] ||
    fail "the guard exempts a harness's own cluster"
fi
"$(dirname "$PSQL")/pg_ctl" -D "$SUPER_ROOT/data" -m fast -w stop >/dev/null
refuses 'was not set up by scratch-pg' env SCRATCH_PG_ROOT="$SUPER_ROOT" bash "$SPG" start --port $((PORT + 2)) --role harness_user
"$(dirname "$PSQL")/pg_ctl" -D "$SUPER_ROOT/data" -m fast -w stop >/dev/null 2>&1 || true
printf 'port=%s\nuser=postgres\n' $((PORT + 2)) >"$SUPER_ROOT/state"
refuses 'predates the scratch role' env SCRATCH_PG_ROOT="$SUPER_ROOT" bash "$SPG" psql postgres -c 'select 1'
rm -f "$SUPER_ROOT/state"
refuses 'no scratch cluster was started here' env SCRATCH_PG_ROOT="$SUPER_ROOT" bash "$SPG" url app
rm -rf "$SUPER_ROOT"

# 7. Stopped, or with something other than the scratch postgres on the recorded port, every client refuses.
bash "$SPG" stop >/dev/null
refuses 'not running' bash "$SPG" psql postgres -c 'select 1'
python3 -c "
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $PORT)); s.listen(); time.sleep(120)" &
LISTENER=$!
for _ in $(seq 50); do awk -v p="$(printf ':%04X' "$PORT")" '$4 == "0A" && $2 ~ p"$" { f = 1 } END { exit !f }' /proc/net/tcp && break; sleep 0.1; done
# A postmaster.pid that names a live postgres from this data directory is gone, so the proof fails first on that.
refuses 'not running' bash "$SPG" psql postgres -c 'drop table if exists t'
# Even with a stale postmaster.pid pointing at the forwarder, the listener's holder is checked.
echo "$LISTENER" >"$SCRATCH_PG_ROOT/data/postmaster.pid"
refuses 'is not postgres' bash "$SPG" dropdb app_test
if [[ -n "${GUARD_CORE:-}" ]]; then
  verdict="$(guard "$line")"
  [[ -n "$verdict" && "$verdict" != allow ]] || fail "the guard exempts a non-postgres listener"
fi

echo "PASS scratch-pg"
