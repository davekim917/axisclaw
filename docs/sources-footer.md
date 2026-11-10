# Sources footer

Every group gets one more small-print line under replies that used a data source:

```
Data read (recorded) · Looker: sales/orders (3 queries) · Snowflake: ANALYTICS.FCT_ORDERS (1 query) · Postgres: app_dev.public.orders (2 queries) · Sheets: Summary!A2:B9 (2 reads) · last call Nov 3, 2026, 9:02 AM EST
```

It is on by default. A group opts out with `sourcesFooter: false` in `container.json`
(`ncl groups config update --id <id> --sources-footer off`, then a restart); `--sources-footer on` erases the key.

The flag gates recording as well as the line. At boot the runner writes `/tmp/nanoclaw-sources/enabled` unless the
group opted out, and every recorder checks that file. With the footer off, the Python tap stops after one `stat` without
patching anything, the `gws` and `psql` shims `exec` the real binary, and the MCP bridge writes nothing. With it on, a failed ledger
write is swallowed, and the wrapped command's exit code, stdout and stderr stay byte-identical; tests pin both modes.
Measured in the image: `python3 -c pass` takes 15 ms with the footer off and 17 ms on (12 ms with `-S`, no site
processing at all). `gws --version` takes 61 ms off and 104 ms on, against 58 ms for the real binary; the cost when on
is the Node recorder. `psql --version` takes 39 ms through the shim off and 60 ms on, against 35 ms for the real
binary.

The line lists the data the agent read while working on the reply, dead ends and cross-checks included. It is not a
claim about which of those the final numbers rest on, which is why it says "Data read" rather than "Sources".

The line is built only from calls the container recorded. The agent cannot add a source it did not call, and it
cannot drop one that a recorder saw.

## Path

1. **Recorders** append one JSON line per call to the container's ledger (`/tmp/nanoclaw-sources/ledger.jsonl`):
   - `remote-mcp-bridge.ts` records `tools/call` for a bridge started as a data source (`looker-mcp.ts`), with its
     arguments, whether it errored and the Looker origin the bridge was configured for. Every provider reaches Looker
     through this bridge. The host shows a Looker system only when that origin is the group's own.
   - `container/source-taps/python/` patches `SnowflakeCursorBase.execute` (sync and `aio`) in every Python process,
     so `snow sql`, `dbt` and any script using the connector are recorded with the SQL they ran. It loads through a
     `.pth` in each interpreter's own site dir (system Python and the snow, dbt and uv venvs). `describe()` calls are
     skipped. An async submission counts once Snowflake accepts it; its later outcome is not observed.
   - `container/source-taps/gws-shim.sh` stands in for `gws`. When recording is on, `gws-record.mjs` runs the real
     binary and records `sheets` commands with their exit status.
   - `container/source-taps/psql-shim.sh` (`/usr/local/bin/psql`, ahead of `/usr/bin/psql`) runs
     `container/agent-runner/src/psql-record.ts` from the mounted runner source when recording is on. It reads the
     script from `-c`, `-f` (regular files only, so a FIFO is never drained) or stdin, which it streams through to psql
     unchanged, and hands psql every descriptor the shim held. The command line carries connection strings with
     passwords inline, so the recorder parses the call in its own process and the entry holds only the database, the
     tables read and whether psql exited 0: never an argument, never SQL text. The database comes from `-d` or the
     first operand (a plain name, the path of a `postgres://` URI, or `dbname=` in a conninfo string) and is dropped
     whenever it cannot be read with certainty, including when any script runs `\c` or `\i`, or the call fails.
   - Tables are named only from `-c` commands. A `-f` or stdin script still decides whether the call was a read and is
     counted with its database, but names nothing: psql may take one of its lines as a password at any prompt, treat
     lines after a COPY as data, or change string quoting part way through, and each can make text that is not SQL
     look like a table name. Each `-c` is read with and without backslash escapes in strings (the server may have
     `standard_conforming_strings` off without the text saying so), and a table counts only where both readings find
     it at the same place in the text. A `-c` is read as the server reads it, since psql sends it unchanged; one that
     starts with a backslash is a meta-command and names nothing.
   - A caller that sets `BUN_OPTIONS` gets psql unrecorded, since the option could stop the recorder starting.
   - A call that can only reach a server on this machine records nothing: such a server is a throwaway test database,
     and listing it would read as data the reply used. Local means a host is given (by `-h`, the target and its URI
     query, or `PGHOST`) and every host is `localhost`, `127.0.0.1`, `::1` or a socket directory. A call with no host
     at all stays recorded, since Debian's `pg_wrapper` then picks the cluster from configuration that may name a
     remote one. Only a call whose every command is a `-c` not starting with a backslash can be skipped: psql sends
     that to the server as written, while a `-f` or stdin script, or a backslash `-c`, is psql input that can switch
     server part way through (`\c`, `\i`, `\e` re-reading an editor's output, a variable whose value is a `\c`).
     Anything else that could choose another server also keeps the call recorded: a `hostaddr` or `PGHOSTADDR` other
     than loopback, a service (`service=`, `PGSERVICE`), a psqlrc that may `\connect` (without `-X`, including a home
     directory that cannot be listed), or a target it cannot parse. A tunnel, port-forward or proxy socket on
     this machine that leads to a remote server, or a local server that itself queries a remote one (`postgres_fdw`,
     `dblink`), is not told apart from a local one, so a read through it goes unrecorded.
2. **Stamp** (`turn-status.ts`, the same seam as the status subtext): a reply to the session's own conversation takes
   every entry no earlier reply took, and `turn-sources.ts` summarises them into `content.sources`. Entries no reply
   took are dropped at the turn boundary. A `sources` key from anywhere else is stripped.
3. **Host** (`src/sources-footer.ts`, called at the delivery door): validates the payload, builds every link from host
   config only (Looker from the group's scoped `LOOKER_BASE_URL_<FOLDER>`, never the bare variable; Sheets from the
   fixed Google host), and replaces `sources` with platform-neutral segments.
4. **Bridge**: renders the footer in the adapter's `subtextMarkup` under the status subtext on the last chunk. On
   Slack this is a `context` block; on Discord a `-# ` line. Status bubbles get nothing.

## What counts

| System    | Counted                                                                                                                                                                        | Not counted                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Looker    | `query`, `run_look`, `run_dashboard` that returned without error                                                                                                               | `query_sql` (returns SQL, not rows), metadata tools, failures                                                                                                                                                                                                                                                                                              |
| Snowflake | Every `SELECT`/`WITH` statement that returned and reads data, not only catalog views, named by the tables it reads where those can be read                                     | DDL, DML, `SHOW`, `describe()`, a single-relation lookup of one `INFORMATION_SCHEMA`/`SNOWFLAKE.ACCOUNT_USAGE` view, session commands, failures                                                                                                                                                                                                            |
| Postgres  | A `psql` call that exits 0 and runs a `SELECT`/`WITH`/`TABLE` reading a relation, or a `COPY ... TO`/`\copy ... to`, named as `<database>.<schema>.<table>` from `-c` commands | writes (including a data-modifying CTE, a CTE followed by `UPDATE`/`DELETE`, and `SELECT ... INTO`), DDL, `COPY ... FROM` and its inline data, session and meta-commands, a `SELECT` of no stored relation (`select 1`, a function, `VALUES`), reads of `information_schema`/`pg_catalog` alone, `-l`, failures, a call that can only reach a local server |
| Sheets    | `gws sheets +read`, `spreadsheets values get/batchGet`, exit 0                                                                                                                 | writes, `--dry-run`, failures                                                                                                                                                                                                                                                                                                                              |

The runner and the `send_message` subprocess consume through one `BEGIN IMMEDIATE` on a SQLite cursor, which a
consumer that dies releases with its process. The ledger is append-only for the container's life; the recorders stop
writing at a 256 MiB runaway ceiling, far above any session's volume, and from then on that container's footers miss
what was not written.

Table names are parsed from the SQL that ran, best effort and never invented: comments, string literals, CTE names
(by Snowflake's identifier rules) and expression `FROM`s (`EXTRACT`, `IS DISTINCT FROM`) are skipped, and a statement
cut at the tap's 200k-character cap names nothing, as does a partial `db..table` name. A read whose tables cannot be
named still counts, and a multi-statement batch counts when any statement in it is a read.

## Paths the recorders do not see

Four paths are recorded: the Looker MCP server, the Snowflake Python connector, the `gws` CLI for Sheets, and the
`psql` CLI for Postgres. A
direct API call (curl, or an HTTP client in Python or Node) to any of these systems is not recorded, so a reply that
made one shows less than it read. This is why the line says "recorded" and never reads as a complete list:

- Snowflake through anything but the Python connector: the SQL REST API over curl, JDBC/ODBC/Node/Go drivers (none
  are installed), or a Python run with `-S`.
- Sheets through anything but the `gws` CLI: Python `googleapiclient`/`gspread`, curl to `sheets.googleapis.com`, a
  Drive export, or running the real binary `/pnpm/gws-real` directly.
- Looker through anything but its MCP server, for example curl or Python against the REST API. These calls pass the
  OneCLI gateway, but its log cannot tell one session of a group from another, so it does not fill the gap. A curl
  tap was built and dropped: matching curl's behaviour exactly in every agent's hot path cost more than the gap.
- Snowflake from a venv the agent made itself without `--system-site-packages`: it has no `.pth`.
- Postgres through anything but `psql` on `PATH`: the Node `pg` client in a script, Prisma, Python drivers, or a psql
  run by absolute path (`/usr/lib/postgresql/15/bin/psql`, a downloaded build).
- psql's exit status is the only success signal. A script run without `ON_ERROR_STOP` exits 0 even when a statement in
  it fails, and with several `-c`/`-f` options the status is the last one's, so a read that failed beside one that
  worked counts as if it ran.
- Postgres reads inside a `\if` block (psql may skip them), and a script psql reads from a pipe or FIFO
  (`-f <(...)`): the recorder never drains a stream psql needs, so it counts nothing from one.
- The tables a `-f` or stdin script reads: such a call shows as `Postgres: <database>` with its count.
- A call still running in the background when its turn ends is credited to the next reply in that session, not to the
  turn that started it.
- A reply whose outbox write fails after it was stamped loses that turn's sources on retry.
- Any process that rewrites the ledger. It sits in the agent's own `/tmp`, so it protects against a model's prose,
  not against a deliberately hostile shell.

The result cache is not visible to any recorder, so the line never says "live". It shows the time of the last call.

## Shape of the line

Each spreadsheet appears once, linked, named by the tabs it read (`Plan, Summary +7 tabs`), not by every range.

A Looker Explore links to the exact query that ran, not to the Explore. The runner keeps each `query` call's arguments
on its Explore object, one object per distinct query (keys sorted, so the same query run twice is one), and the host
rebuilds Looker's expanded Explore URL from them (`?fields=…&f[view.field]=…&pivots=…&sorts=…&limit=…&query_timezone=…&dynamic_fields=…`),
with no Looker API call and nothing written to Looker. One query on an Explore: the Explore's name links to it. Several:
`sales/orders (q1, q2)`, each numbered link its own query. A query links to the Explore instead, marked `Explore only`,
when its definition fails validation (a field or sort that is not a LookML name, a non-text filter value), when it
asks for more rows than an Explore shows (`limit` above 5,000, or `-1`), when it carries an argument no documented URL parameter holds (`filter_expression`, Looker's custom filter, is one: a link
that dropped it would show different rows), or when its URL does not fit the line. An Explore object without a query
definition, from a runner older than this, links to the Explore unmarked, as before. A URL is never cut.

The URL carries what the Looker MCP sent Looker, not what the agent typed: it strips one pair of outer quotes from each
filter value, and a query that names no `tz` runs in the MCP's own zone (the container's `TZ`), which the runner
writes into the definition. One rewrite is not mirrored: for a LookML `type: unquoted` parameter the MCP escapes `_`
and `%` after looking the field up, so such a link may open with Looker's "filter is not allowed" error, never with
other rows.

A system lists up to five names. A line whose visible text (link text, not URLs) runs past 300 characters, or whose
markup runs past 1000, first swaps its longest query links for their Explore's link, then sheds names one at a time
from the longest list, keeping each system's first name until nothing else is left, so systems and counts always stay.
The 1000 is well inside the platforms' own caps (Slack: 3000 for the context block's text, status line included;
Discord: 2000 for the whole message), and it is what the bridge reserves out of every body chunk for the small print,
so raising it shortens every chunk of a long reply.
