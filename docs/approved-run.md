# Approved runs

An agent proposes an exact privileged file (Snowflake admin SQL or a Snowflake migration, a Render API write, or numbered Postgres migrations) with the `propose_run` tool instead of asking a human to paste it on the host. The host classifies every statement and does one of two things. There is no auto tier: nothing runs without a named approver seeing every statement.

| Tier | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| card | every statement the classifier fully parses as one of its accepted shapes (USE, SHOW, CREATE ROLE/USER/WAREHOUSE/DATABASE/SCHEMA/DATABASE ROLE/internal STAGE/FILE FORMAT with listed properties, ALTER SCHEMA … ENABLE MANAGED ACCESS, grants, revokes and ownership moves of listed privileges on listed object types, and the data statements: CREATE TABLE [IF NOT EXISTS] with a column list, CREATE [OR REPLACE] VIEW or DYNAMIC TABLE (optionally naming its columns, each with an optional COMMENT), MERGE, and read-only SELECT or WITH)                                                                                                                                                                                                                                                                                                                                                     | a card in the work thread that only the target's named approvers can answer; it opens with one plain sentence (what changes, where, what could be lost), the classifier's summary, then **every statement that needs approval, verbatim**, each under the role, database and schema it runs in. When they don't all fit, the data statements are shown by reference instead (kind, object, OR REPLACE flag, first line, their own sha256, and a MERGE's WHEN actions) and the card opens by saying so; grants and the admin shapes are always verbatim. The card must fit the smallest platform it lands on, the thread's or any approver's (each gets a DM copy on their own platform): about 1,600 characters on Discord, about 2,500 on Slack. A file that still doesn't fit, or holds a code fence or invisible character, gets no card |
| deny | everything else, by default. Also anything that touches a system role (ACCOUNTADMIN, ORGADMIN, SECURITYADMIN, USERADMIN, SYSADMIN, PUBLIC) as grantee or granted role, except rolling a role created earlier in the same file up to SYSADMIN when the file grants nothing else into it; ownership of a role the file didn't create; role switches off the target's list; statements snow would send differently from how they were read; CREATE OR REPLACE TABLE, CLONE, LIKE and CREATE TABLE … AS SELECT; a data statement whose body holds CALL, EXECUTE IMMEDIATE, a `SYSTEM$` name, COPY, PUT, GET or any DDL, calls anything but a listed built-in function, or names its object through IDENTIFIER or TABLE; or a view or SELECT that writes; and a table or view created, or merged into, outside the schemas the target lists | refused with the reason; the agent splits the file or it stays a human step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The file's sha256 binds the card: "Run it" re-enters the guarded entry (`approved_run.execute`, `src/modules/approved-run/`) with the approval row as its grant, the classifier re-runs on the stored bytes, and a card older than 24 hours, a changed file, or a target whose configuration changed since the card was posted runs nothing. Each request runs at most once, however many cards it produced.

No card is posted for a target whose key isn't in place. Before the card, the host checks that each identity the request would run as holds its `<onecliAgent> token` and that no other agent does: for a migration, the identities of the databases it names. A target written before its key is stored stays dormant: its proposals get "isn't set up yet, nothing was proposed". If the vault can't be read, the agent is told the host couldn't check, and nothing is proposed either. Reading every agent's grants takes seconds, so this check, like a migration's repository checks, runs in the background, one request per target at a time, and the card follows; the delivery loop never waits on it. The run repeats the check before anything is sent.

## Running an approved file

On approval the host runs the file itself, as the target's Snowflake service user, through the Snowflake SQL API (`src/modules/approved-run/execute.ts`). Each classified statement is one request carrying exactly the text the card showed, its role, database, schema and warehouse as request fields, and `MULTI_STATEMENT_COUNT: 1`, so Snowflake itself rejects a request holding a second statement. USE statements are never sent (the SQL API refuses them); their effect travels in the fields. The host never holds the token: it calls through the OneCLI gateway as the target's `onecliAgent`, and the gateway injects the role-restricted programmatic access token (Snowflake ignores secondary roles in such a session). Before the first statement the run refuses unless the vault shows the token granted to that agent and to no other, and a session check shows the configured user, the expected role and no secondary roles. The run directory under `data/approved-run/runs/<run-id>/` is created before any request as the exactly-once claim; its log is written before and after every statement. A lost response is resent under the same request id with `retry=true`, which Snowflake does not re-execute once it succeeded. The run stops at the first failure, and the thread gets which steps ran, the one that failed or whose outcome is unknown (with its query tag), and that a retry is a new proposal for the rest. A host that restarts mid-run posts the same account of the cut-off run at boot; a run whose step log cannot be read is reported as unknown, with the query-tag prefix to check.

Every report of what ran, or did not (run outcomes, "Nothing ran" refusals, the token guard's alert for a grant it removes), is queued under `data/approved-run/outbox/` before the event it reports is recorded as settled, and removed only once each of its legs (thread, agent, owner DM) has been delivered (`src/modules/approved-run/outbox.ts`). A leg that fails is retried by the token guard's sweep pass, which runs every 10 minutes; one already delivered is never resent, and a crash between a delivery and its record sends that leg twice rather than not at all. Each failure doubles the wait before that leg's next try (10 minutes, then 20, 40, …), so a leg failing for good is tried about ten times in a week. A report still undelivered after 7 days is dropped with an error in the host log, and the owner gets a DM holding what each undelivered leg said (an undelivered owner DM is only logged).

## Configuring a target

`data/approved-run/targets.json` (installation config, not in the repo):

```json
{
  "targets": [
    {
      "id": "example-snowflake",
      "label": "Example Snowflake",
      "kind": "snowflake",
      "agentGroups": ["ag-example"],
      "approvers": ["slack:U0EXAMPLE1", "slack:U0EXAMPLE2"],
      "allowedRoles": ["SECURITYADMIN", "SYSADMIN"],
      "defaultRole": "EXAMPLE_DEPLOY",
      "classifier": { "path": "/abs/path/classify.py", "sha256": "<64 hex>", "snowRoot": "/abs/path/to/snow-install" },
      "schemas": ["EXAMPLE_DEV.APP"],
      "repo": "example-org/warehouse",
      "mode": "execute",
      "execute": {
        "account": "exampleorg-example1",
        "user": "APPROVED_RUN_EXAMPLE",
        "onecliAgent": "approved-run-example",
        "warehouse": null
      }
    }
  ]
}
```

- `execute.onecliAgent` must be an `approved-run-*` identifier; its token is the vault secret named `<onecliAgent> token`. That name reserves it by a rule in code (`src/reserved-secrets.ts`), not by this file, so a missing or broken `targets.json` releases nothing: no container may run as an `approved-run-*` agent, a spawn declaring a reserved token fails, `ncl secrets grant` refuses one, and a sweep duty (`approved-run-token-guard`, every 10 minutes) queues an owner alert for, then removes, any grant made straight against the vault (the alert is queued first, so a removal that succeeds and is never seen again is still reported), DMs the owner about any agent it cannot strip, and about a lane agent holding a secret not named as its own token. The token is injected as `Authorization: Bearer {value}` for host `<account>.snowflakecomputing.com`, path `/api/v2/statements*`. `warehouse` is used only for the session check.
- `approvers` must also hold admin privilege on the requesting agent group; a card answers only to the listed users.
- `allowedRoles` may never include ACCOUNTADMIN or ORGADMIN.
- `defaultRole` (required, never ACCOUNTADMIN or ORGADMIN) is the role every step runs as until the file's own `USE ROLE`. No step falls back to the connection's default role, and the host refuses a statement whose role is neither this one nor on `allowedRoles`. A GRANT, REVOKE or ownership move is refused unless a `USE ROLE` comes before it in the file: the default role is meant for creating roles and users, and a grant left on it fails at run time on any database it cannot see, after the card was already approved.
- `schemas` (optional) lists the `DB.SCHEMA` names a file may create a table, view or dynamic table in, or MERGE into. Without it no such statement reaches a card. A view or SELECT may read any schema the run's role can see. A MERGE may read only listed schemas, since a MERGE that reads a stream advances it. It takes one of two forms: `USING <table>` with no subquery anywhere in the statement, or a `USING` that is a VALUES list, bare or under one `SELECT … FROM VALUES` with no other `FROM`, which reads nothing. No reserved word may stand as an alias. Any other MERGE is refused rather than parsed. The card lists what each MERGE reads. The check sees the names a MERGE reads, not what those objects are: a MERGE reading a listed-schema view still reads whatever the view selects from, and when the same file creates that view, its statement is on the card, or at the checked link when the card shows statements by reference. A data statement may not quote an identifier: a quoted name must read the same unquoted, so quoting can only disguise a keyword. A sequence's NEXTVAL is refused outside a column default, since reading it uses up values.
- `repo` (optional, `owner/name` on GitHub) is where this target's files are merged. A proposal may name `source: { commit, path }`; the host fetches develop and main into its own mirror (`data/approved-run/repos/`), and links the file on the card only when that commit is on one of them and the file there is byte for byte the proposed one. A proposal without a checked source gets no card when any data statement must be shown by reference, or when a long VALUES list is cut.
- A VALUES list of more than six rows is shown on the card as its first and last three rows, with its row count and the sha256 of the exact text left out. The classifier cuts only a VALUES list, and refuses the statement when any row of such a list is not literals only (strings, numbers, NULL, TRUE, FALSE). What runs is the statement as written, never the shown form.
- What a SELECT or SHOW returns goes to the agent, never to the thread.
- A data statement's body may call only the built-in functions the classifier lists (`FUNCTIONS` in `classify_snowflake.py`), bare and unquoted. Anything else is refused: a user-defined or external function, a procedure read through `TABLE(…)`, `TO_QUERY`, a `SNOWFLAKE.*` service such as Cortex, or a method called with `!`. Words that take a parenthesised list without calling anything (IN, EXISTS, VALUES, OVER, sized types and the like) are listed separately. `USING (…)` passes only as a MERGE's own USING, so `JOIN … USING (cols)` is refused (write `ON`), and `IDENTITY(…)`/`AUTOINCREMENT(…)` are refused while the bare keywords pass. A migration that needs another built-in adds one line to the list.
- The Snowflake classifier's source of record is `scripts/approved-run/classify_snowflake.py`, with its suite in `test_classify_snowflake.py` beside it; changes go through a PR. The host runs the installed copy at the `classifier.path` the target names, pinned by its sha256, and the operator installs and re-pins it. `snowRoot` is the snow install the pinned launcher runs; it is passed in, never written into the classifier, and the classifier refuses to run without one. Its suite needs that install: `APPROVED_RUN_SNOW_ROOT=<snowRoot> scripts/test-safe.sh scripts/approved-run/classify-snowflake.test.ts` runs it on the host, and skips it where no install is named or the install can't be read.
- The classifier is run as `python3 -I <path> --facts --allowed-roles <A,B> --default-role <R> --snow-root <snowRoot> <file>` and must print `{"statements": [{"text", "kind", "scope", "role", "database", "schema", "warehouse", "deny", "grantee", "object", "drops_grants", "replaces", "actions", "sources", "display", "collapsed"}]}`, where `text` is the exact statement the run will send, a `merge` must carry `actions` and `sources`, and the four context fields are plain identifiers or null. The host refuses output that breaks this, and refuses when the classifier's sha256 doesn't match the pin. Kinds and their tiers are the table in `src/modules/approved-run/classify.ts`; a kind not listed there is denied.

## Render targets

A `kind: "render"` target lets agents propose one Render API write on production resources. Render's protected environments refuse these writes to the agents' own Developer-role key. There is no classifier file: the operation table in `src/modules/approved-run/render-request.ts` is the policy. A request is accepted only as one of these operations, on a resource the target lists, with exactly the body that operation takes:

| Operation              | Request                                                 | Body                                               |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| set an env var         | `PUT /v1/services/<id>/env-vars/<KEY>`                  | `{"value": "<string>"}`                            |
| delete an env var      | `DELETE /v1/services/<id>/env-vars/<KEY>`               | none                                               |
| one-off job            | `POST /v1/services/<id>/jobs`                           | `{"startCommand": "<command>"}`, optional `planId` |
| auto-deploy            | `PATCH /v1/services/<id>`                               | exactly `{"autoDeploy": "yes" \| "no"}`            |
| add a custom domain    | `POST /v1/services/<id>/custom-domains`                 | `{"name": "<domain>"}`                             |
| verify a custom domain | `POST /v1/services/<id>/custom-domains/<domain>/verify` | none                                               |
| replace routes         | `PUT /v1/services/<id>/routes`                          | a JSON array or object                             |

Everything else is denied and nothing is shown. That includes deleting, suspending, resuming or creating services and databases; any other service setting, such as repo, branch, image, build, start or pre-deploy commands; database changes and exports; secret files; deploys; environment changes; paths with a query string, an escape or a dot segment; and any resource the target doesn't list. Deploys stay on the agents' own key, which protected environments still allow.

Approval works as it does for Snowflake: only the target's named approvers may answer, and each must be an owner or an admin of the requesting agent group when they click. Agents propose with `propose_render_change`. The card shows the method, path and body exactly. The sha256 of the canonical request binds the approval, as a file's sha256 does for Snowflake. An env value is shown in plaintext only when the resource lists its key in `plaintextEnv`. Even then, a value holding an `@` (a URL's userinfo), or one with a query, fragment or scheme that doesn't parse as a URL, is masked whole, and a parsed URL's query and fragment are masked. The card says so whenever any part of a new value is masked. Every other value shows as its length and a keyed HMAC-SHA256. The key is derived per target from `data/approved-run/render-mask.key` (0600, created on first use), so a short secret can't be recovered by hashing guesses, equal values still mask the same within a target, and a value an agent sets on one target can't be compared with a mask on another.

On approval, the host sends the request once through the OneCLI gateway as `execute.onecliAgent`. It first checks that the vault grants `<onecliAgent> token` to that agent and no other, and that `GET /v1/users` returns `execute.adminUserId`. The write is never resent, because a second env-var change or job is a second change. A lost answer, or a 5xx from Render, is reported as unknown. Check the resource in the dashboard before proposing it again. The run directory and outbox work as they do for Snowflake.

`render_env_read` answers an agent's env read for a listed service or cron job without a card. The host fetches the values as the same reserved identity and returns every key, masked by the same rules, so no secret value reaches the container.

```json
{
  "id": "example-render",
  "label": "Example Render",
  "kind": "render",
  "mode": "execute",
  "agentGroups": ["ag-example"],
  "approvers": ["slack:U0EXAMPLE1"],
  "execute": { "onecliAgent": "approved-run-example-render", "adminUserId": "usr-exampleexampleexample" },
  "resources": {
    "srv-exampleexampleexample": { "label": "Example backend", "plaintextEnv": ["NODE_ENV", "FEATURE_FLAG"] }
  }
}
```

The reserved token is injected as `Authorization: Bearer {value}` for host `api.render.com`.

## Migration targets

A `kind: "repo-migrate"` target lets agents propose numbered migration files for databases they may not migrate themselves. Agents propose with `propose_migration`: an ordered list of up to 8 files at one commit, each named by `database`, file stem and sha256. There is no SQL in the proposal. Classification runs in the background, off the delivery loop, and the card is posted when it finishes. The host fetches the repository into a private mirror whose `info/attributes` switches every Git attribute off, and refuses the whole list unless the commit is on `develop` or `main` and every file there hashes to its sha256. It then calls the repository's own facts module at that commit, in a sandbox container with no network: a file it gives a `refuse` reason for is refused with that reason, and each file's safety classes and irreversible statements go on the card.

The facts module exports `approvedRunFacts({ root, files, folders })`, where `files` is `[{ migration, path, checked }]` in proposal order and `folders` lists the migration stems at the commit for each `checked` folder. It returns, in the same order, `[{ refuse: string | null, classes: [{ name, why }], irreversible: string[] }]`.

On approval, the host checks the commit, the hashes and the token again, and extracts the files and the apply script with its imports from that same commit. Each extracted migration must be a regular file whose bytes hash to the approved sha256. The host then reads each database's connection details itself, as the database's reserved identity, for the `postgresId` the target pins, and runs `<applyScript> apply --target <database> …` once per file in a sandbox container, never on the host. The sandbox sits on a network of its own with no route out. Its only way to the database is a relay container the host starts for that step, which forwards one port to the one host and port Render returned. The sandbox reaches the relay under the database's real hostname, so TLS still names that host. The relay accepts connections only from the run's network, and it and the network are removed when the step ends, or at the next boot after a crash. The sandbox gets only those connection details, as a read-only file named by `RENDER_CONNECTION_INFO_FILE`, removed when the run ends. No gateway identity, proxy or Render key enters it. Each file is its own transaction with its ledger row. The list stops at the first file that does not apply, and the files before it stay applied. A nonzero exit, a timeout or an overflow after the apply script began sending a file reports that file as unknown, with the ledger check first. One run per database runs at a time. The database password, every value the apply script masks, and any password in a postgres URL, a `PGPASSWORD=` setting or a JSON `password` field are removed from both output streams before anything is stored or posted. The card warns when a `watched` or `extract` path changed since the last approved run, since that code runs with the database password. A target with no approved run of its own can name another target in `compareWith`. Its cards then compare with that target's last approved run, and say so with a direct diff, provided that target reads the same repository, records the same files, and has no approver this target lacks. Otherwise they compare with nothing, and the host logs why. A production target can name its dev target, so its first card is compared with what ran on dev.

The apply script is trusted with that password, the same password the repository's deployed backend holds. Redaction catches a password printed by accident. The network boundary stops a script from sending the password anywhere but the database. A script written to leak it could still print it encoded, past the redaction, which reaches the approver's thread and the run record. The real control is review: the code at the approved commit is merged code, and the drift warning tells the approver when the code that handles the password has changed. The Render key and the gateway identity, which reach beyond one database, never enter the sandbox. Sandbox output is never written to the container runtime's logs, and an overflowed run keeps none of its output.

```json
{
  "id": "example-migrate",
  "label": "Example migrations",
  "kind": "repo-migrate",
  "mode": "execute",
  "agentGroups": ["ag-example"],
  "approvers": ["slack:U0EXAMPLE1"],
  "repo": "example-org/example-repo",
  "compareWith": "example-migrate-dev",
  "layout": {
    "applyScript": "tools/migrate/apply.mjs",
    "extract": ["tools/migrate", "backend/scripts"],
    "watched": ["tools/migrate/apply.mjs"],
    "factsModule": "tools/migrate/facts.mjs"
  },
  "databases": {
    "app": {
      "folder": "backend/migrations",
      "onecliAgent": "approved-run-example-app",
      "postgresId": "dpg-exampleexampleexample",
      "checked": true
    },
    "hub": {
      "folder": "registry/migrations",
      "onecliAgent": "approved-run-example-hub",
      "postgresId": "dpg-exampleexampleexamplf",
      "checked": false
    }
  }
}
```

Every path is relative to the repository root. `databases` names the apply-script targets a card may select: all production names or all `-dev` names, never a mix. A database that shares an instance with a production database gets no dev target: its credential is the production one. The host reads each database's connection details as that database's reserved identity, holding `<onecliAgent> token`.
