---
name: scratch-postgres
description: >-
  Start and use a throwaway Postgres inside this container, with data under /tmp, for tests,
  migrations, e2e runs, seeding or a live preview's backend. Use whenever you need a local,
  scratch, test or throwaway Postgres database, and for every psql, createdb or dropdb you run
  against one, including deletes, drops and truncates, which then need no approval.
---

# scratch-postgres

One script does it all, at `/home/node/.claude/skills/scratch-postgres/scratch-pg`:

```bash
SPG=/home/node/.claude/skills/scratch-postgres/scratch-pg
$SPG start                      # or: $SPG start --port 55432
$SPG createdb app_test
$SPG psql app_test -c 'drop table if exists orders'
$SPG psql app_test -qtA -c 'select count(*) from users'
$SPG dropdb app_test
$SPG url app_test               # postgresql://scratch@127.0.0.1:5432/app_test, for the app's env
$SPG stop
```

Starting again while it runs changes nothing. Data lives in `/tmp/scratch-pg` and disappears with the
container, so each session migrates and seeds again.

Run every psql, createdb and dropdb against this database through the script, never by hand. The
destructive-command guard can't tell a hand-written connection string, `localhost` or a `$VAR` from a
real database, and sends those to a person for approval. Before connecting, the script checks that the
port is held by the postgres it started from `/tmp`, so its drops and deletes run without approval.

What it accepts, and refuses otherwise:

- **psql:** SQL given with `-c` (repeatable), plus display flags such as `-q`, `-t`, `-A`, `--csv`
  and `-v name=value`. It refuses `-h`, `-p`, `-d`, `-f`, a connection string and any backslash
  meta-command, since each of those can connect somewhere else or hide the SQL. To run a file, pass
  its statements with `-c`, or point the app's own migration tool at `$SPG url <db>`.
- **Database names:** letters, digits and `_` only.
- **Login role:** everything connects as one role, `scratch` by default, which can create and drop
  databases but is not a superuser. Postgres refuses it dblink, postgres_fdw, `COPY … PROGRAM`,
  untrusted extensions and server files, so nothing run here reaches a real database. No other role,
  the setup superuser included, can log in.

## A test harness that starts its own Postgres

A drop on a Postgres a harness started for itself needs approval, because its superuser login could
reach a real database. Start the cluster with this script instead, under the role the harness logs in
as, and point the harness at its port:

```bash
$SPG start --port 5499 --role app_user
```

The harness's own `psql -X -h 127.0.0.1 -p 5499 -U app_user …` drops then need no approval.

If its migrations create roles, the login role can't (it has no CREATEROLE, which would let it grant itself
server-program rights). Have setup make them instead, with no login and no privileges, and add `:member` where
the migration needs to `SET ROLE` to one:

```bash
$SPG start --port 5499 --role app_user --extra-role report_reader --extra-role report_owner:member
```

The extra roles are fixed when the cluster is first made; changing them means stop, remove `/tmp/scratch-pg`, start.

The app's own tools (migrations, seeds, the backend) connect with `$SPG url <db>` like any app
would. The guard doesn't see those connections, and they need no approval.

If a database holds real data, don't use this skill: write that database's host out in full in your
psql command, and the command goes to approval.
