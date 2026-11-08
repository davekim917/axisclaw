#!/usr/bin/env python3
"""Approved-run Snowflake classifier (installation side; pinned by sha256 in targets.json).

Deny by default. A statement reaches a named approver's card only when it fully
parses as one of a small set of shapes (USE, SHOW, a few CREATEs with listed
properties, and grants/revokes of listed privileges on listed object types),
with every name extracted by the parser. Anything else is refused. System roles
are untouchable, as grantee and as granted role, except rolling a role this
file created up to SYSADMIN when nothing else in the file grants into it.

What runs is exactly what this file judged. Boundaries come from snow's own
splitter (pinned); each statement is then pushed through the whole path one
run.sh step takes (snow's reader, its dedent, the connector's re-split and
cursor rewrite), using the pinned install's own code, and refused unless the
server would receive exactly its text. Every step names its role explicitly.

  --facts               emit {"runner": ..., "statements": [...]} for the host (the default output is a summary)
  --allowed-roles A,B   roles USE ROLE may switch to
  --default-role R      the role a step runs as before any USE ROLE; required
  --snow-root PATH      the snow install the pinned launcher runs; required
Tests: APPROVED_RUN_SNOW_ROOT=<the --snow-root install> python3 -I test_classify_snowflake.py
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import types
import unicodedata

RUNNER = "/usr/local/bin/snow"
# snow 3.15.0: every file on the path from `snow sql -f` to the server, under the install's site-packages. Any other
# version refuses every file. The pyapp launcher embeds its install id; --snow-root must name the install that launcher
# runs. Nothing here checks that link, so the operator copies it from the launcher's install, not from any other.
SITE_PINS = {
    "snowflake/connector/util_text.py": "d71028a84c5019ff7508f1a3c4f71f258daee02a3c46c1c6f6d7f30a943d1b3e",
    "snowflake/cli/_plugins/sql/statement_reader.py": "e396da76094f44e7ee87ae40f095c84018021ced6d4265c476f99f68c8204f95",
    "snowflake/cli/_plugins/sql/manager.py": "b1ed2d0fcf1dab7ba59172bf25bc1bd7c6bcb2894d49210342f896e24e984d2d",
    "snowflake/cli/_plugins/sql/commands.py": "3bbba2357f38b632cce038244d2d4b4628ba004600f1f280bcfc41a8c8a0ad40",
    "snowflake/cli/api/rendering/sql_templates.py": "e9503a95b9a4bc85c5cb661b4e663436f3b3a76f0e52bd8a8a09c030f49c6e94",
    "snowflake/cli/api/sql_execution.py": "81f17c79b04202bbaabd15f47ed5caaf840e1c1e8fedd8e758e59af8285c0a3a",
    "snowflake/connector/connection.py": "4eebecd1a4ae42c1d412d4ecb9d12bcc7e77fb72785f1d4f7a1b9a7e4f42892a",
    "snowflake/connector/cursor.py": "66e20c3ea5c0d984412e818085bce5671ed24e7930ff0add9e916a8f34fe9493",
}
SNOW_ROOT = SNOW_SITE = SNOW_PYTHON = SPLITTER = ""
PINS: dict[str, str] = {}


def configure(snow_root: str) -> None:
    global SNOW_ROOT, SNOW_SITE, SNOW_PYTHON, SPLITTER
    if not snow_root or not os.path.isabs(snow_root) or not os.path.isdir(snow_root):
        sys.exit("--snow-root must name the snow install's directory")
    SNOW_ROOT = snow_root.rstrip("/")
    SNOW_SITE = f"{SNOW_ROOT}/lib/python3.10/site-packages"
    SNOW_PYTHON = f"{SNOW_ROOT}/bin/python3"
    SPLITTER = f"{SNOW_SITE}/snowflake/connector/util_text.py"
    PINS.clear()
    PINS[RUNNER] = "b354f71c5816900531c4bd9e1d6488606cd9ef221e0591554d5a90425e42fc55"
    PINS.update({f"{SNOW_SITE}/{rel}": want for rel, want in SITE_PINS.items()})


SESSION_SQL = "USE SECONDARY ROLES NONE;\n"
# One run.sh step (`--enable-templating NONE --retain-comments -f session.sql -f statement.sql`), as the server gets it:
# snow's reader, then sql_execution's dedent, the connector's re-split, and cursor.execute's strip and DESC rewrite.
SNOW_SENDS = """
import io, json, os, sys, tempfile
from functools import partial
from pathlib import Path
from textwrap import dedent
from snowflake.cli.api.secure_path import SecurePath
from snowflake.cli._plugins.sql.statement_reader import files_reader, compile_statements
from snowflake.cli._plugins.sql.commands import _parse_template_syntax_config
from snowflake.cli.api.rendering.sql_templates import snowflake_sql_jinja_render
from snowflake.connector.util_text import split_statements
from snowflake.connector import cursor as C
ops = [partial(snowflake_sql_jinja_render, template_syntax_config=_parse_template_syntax_config(["NONE"]), data={})]
d = tempfile.mkdtemp()
sess, step = os.path.join(d, "session.sql"), os.path.join(d, "statement.sql")
with open(sess, "w", encoding="utf-8", newline="") as f:
    f.write(sys.argv[1])
out = []
for text in json.load(sys.stdin):
    with open(step, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    try:
        errors, _, compiled = compile_statements(files_reader([SecurePath(Path(sess)), SecurePath(Path(step))], ops, False))
        final = []
        for c in compiled:
            if c.command or c.execute_async or not c.statement:
                final.append(None)
                continue
            for sql, putget in split_statements(io.StringIO(dedent(c.statement)), remove_comments=False):
                if not sql:
                    continue
                q = sql.strip(" \\t\\n\\r")
                final.append(None if C.DESC_TABLE_RE.match(q) or putget else q)
        out.append({"final": final, "errors": [str(e) for e in errors]})
    except Exception as e:
        out.append({"final": [], "errors": [repr(e)[:200]]})
json.dump(out, sys.stdout)
"""

SYSTEM_ROLES = {"ACCOUNTADMIN", "ORGADMIN", "SECURITYADMIN", "USERADMIN", "SYSADMIN", "PUBLIC"}
FORBIDDEN = re.compile(r"ACCOUNTADMIN|ORGADMIN")
# Every object the lane's bootstrap creates is named APPROVED_RUN_*: its role, user and network policy, and the watch
# database, task and email integration. A file naming one could widen the lane or blind the alert.
LANE_OWN = re.compile(r"APPROVED_RUN")
PLAIN = re.compile(r"^[A-Z_][A-Z0-9_$]{0,254}$")

# Privileges a card may grant or revoke. OWNERSHIP has its own shape; anything else (MANAGE GRANTS, EXECUTE TASK,
# IMPORTED PRIVILEGES, APPLY …) is refused.
SINGLE_PRIVS = {"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "USAGE", "MONITOR", "OPERATE",
                "MODIFY", "READ", "WRITE"}
CREATABLE = {("SCHEMA",), ("TABLE",), ("VIEW",), ("STAGE",), ("FILE", "FORMAT"), ("SEQUENCE",), ("FUNCTION",),
             ("PROCEDURE",), ("TASK",), ("STREAM",), ("MATERIALIZED", "VIEW"), ("DYNAMIC", "TABLE"),
             ("DATABASE", "ROLE")}
OBJECT_TYPES = {("DATABASE",): 1, ("SCHEMA",): 2, ("TABLE",): 3, ("VIEW",): 3, ("MATERIALIZED", "VIEW"): 3,
                ("DYNAMIC", "TABLE"): 3, ("WAREHOUSE",): 1, ("TASK",): 3, ("STAGE",): 3, ("FILE", "FORMAT"): 3,
                ("SEQUENCE",): 3, ("STREAM",): 3, ("DBT", "PROJECT"): 3}
ROUTINES = {("PROCEDURE",), ("FUNCTION",)}
PLURALS = {("TABLES",), ("VIEWS",), ("MATERIALIZED", "VIEWS"), ("DYNAMIC", "TABLES"), ("SCHEMAS",), ("TASKS",),
           ("PROCEDURES",), ("FUNCTIONS",), ("STAGES",), ("FILE", "FORMATS"), ("SEQUENCES",), ("STREAMS",)}
USER_PROPS = {"TYPE": "word", "LOGIN_NAME": "str", "DISPLAY_NAME": "str", "FIRST_NAME": "str", "LAST_NAME": "str",
              "EMAIL": "str", "COMMENT": "str", "DEFAULT_ROLE": "name", "DEFAULT_WAREHOUSE": "name",
              "DEFAULT_NAMESPACE": "name", "DEFAULT_SECONDARY_ROLES": "empty", "DISABLED": "bool",
              "NETWORK_POLICY": "name"}
# No RSA_PUBLIC_KEY: an agent-supplied key would mint a login no approver can check; keys are set by a human.
WAREHOUSE_PROPS = {"WAREHOUSE_SIZE": "size", "AUTO_SUSPEND": "num", "AUTO_RESUME": "bool",
                   "INITIALLY_SUSPENDED": "bool", "MIN_CLUSTER_COUNT": "cluster", "MAX_CLUSTER_COUNT": "cluster",
                   "SCALING_POLICY": "word", "STATEMENT_TIMEOUT_IN_SECONDS": "num", "COMMENT": "str"}
WAREHOUSE_SIZES = {"XSMALL", "SMALL", "MEDIUM"}
MAX_CLUSTERS = 2
CONTAINER_PROPS = {"COMMENT": "str", "DATA_RETENTION_TIME_IN_DAYS": "num"}
# An internal stage only: no URL, storage integration or credentials.
STAGE_PROPS = {"COMMENT": "str"}
FILE_FORMAT_PROPS = {"TYPE": "word", "FIELD_DELIMITER": "word", "RECORD_DELIMITER": "word",
                     "FIELD_OPTIONALLY_ENCLOSED_BY": "word", "ESCAPE": "word", "ESCAPE_UNENCLOSED_FIELD": "word",
                     "NULL_IF": "strlist", "EMPTY_FIELD_AS_NULL": "bool", "TRIM_SPACE": "bool", "SKIP_HEADER": "num",
                     "ENCODING": "str", "COMPRESSION": "word", "COMMENT": "str"}


class Refuse(Exception):
    pass


def load_splitter():
    """Pinned snow source, executed from the same bytes that were hashed."""
    loaded = {}
    for path, want in PINS.items():
        try:
            with open(path, "rb") as f:
                loaded[path] = f.read()
        except OSError:
            raise Refuse(f"snow CLI source {path} is missing; the classifier can't know what snow would run")
        if hashlib.sha256(loaded[path]).hexdigest() != want:
            raise Refuse("the installed snow CLI is not the version this classifier was verified against")
    mod = types.ModuleType("snow_util_text")
    mod.__file__ = SPLITTER
    exec(compile(loaded[SPLITTER].decode("utf-8"), SPLITTER, "exec"), mod.__dict__)
    return mod.split_statements


def snow_sends(texts: list[str]) -> list[dict]:
    try:
        out = subprocess.run([SNOW_PYTHON, "-I", "-c", SNOW_SENDS, SESSION_SQL], input=json.dumps(texts),
                             capture_output=True, text=True, timeout=60,
                             env={"PATH": "/usr/bin:/bin", "LD_LIBRARY_PATH": f"{SNOW_ROOT}/lib"})
        sent = json.loads(out.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise Refuse("snow's own reader could not be run to confirm what each step would send")
    if not isinstance(sent, list) or len(sent) != len(texts):
        raise Refuse("snow's own reader gave an unreadable answer")
    return sent


def snow_statements(split_statements, text: str) -> list[str]:
    """The statements `snow sql -f` sends, in order (files_reader + compile_statements with templating off)."""
    out = []
    for stmt, _ in split_statements(io.StringIO(text), remove_comments=False):
        if not stmt:
            continue
        if all(not line.strip() or line.lstrip().startswith("--") for line in stmt.splitlines()):
            continue
        out.append(stmt)
    return out


# --- tokens -------------------------------------------------------------------------------------------------------

TOKEN = re.compile(r"""
    (?P<ws>[ \t\n]+)
  | (?P<comment>--[^\n]*)
  | (?P<str>'(?:[^'\\\n]|'')*')
  | (?P<qid>"(?:[^"\n]|"")*")
  | (?P<id>[A-Za-z_][A-Za-z0-9_$]*)
  | (?P<num>[0-9]+)
  | (?P<sym>[.,()=;])
""", re.X)


def refuse_unplain(stmt: str) -> None:
    """Refuse the first character outside printable ASCII, tab and newline, saying which one and where, so the author
    can replace it. The message itself stays ASCII: an excerpt of the line around that character is quoted with every
    such character escaped."""
    def plain(ch: str) -> bool:
        return " " <= ch <= "~" or ch == "\t"

    def escaped(ch: str) -> str:
        return ch if " " <= ch <= "~" else f"\\u{ord(ch):04X}" if ord(ch) <= 0xFFFF else f"\\U{ord(ch):08X}"

    for n, raw in enumerate(stmt.split("\n"), 1):
        line = raw.strip(" \t")
        at = next((i for i, ch in enumerate(line) if not plain(ch)), None)
        if at is None:
            continue
        bad = line[at]
        start = max(0, at - 30)
        end = min(len(line), start + 60)
        shown = ("..." if start else "") + "".join(map(escaped, line[start:end])) + ("..." if end < len(line) else "")
        name = unicodedata.name(bad, "") or ("control character" if unicodedata.category(bad) == "Cc" else "unnamed character")
        raise Refuse(f"has a non-ASCII or control character, U+{ord(bad):04X} {name}, on line {n} of the statement "
                     f"({shown}); replace it with plain ASCII")


def tokenize(stmt: str) -> list[tuple[str, str]]:
    """Plain names (quoted ones only when they equal a plain name), single-line literals, numbers, . , ( ) = ;"""
    refuse_unplain(stmt)
    toks, i = [], 0
    while i < len(stmt):
        m = TOKEN.match(stmt, i)
        if not m:
            ahead = stmt[i:i + 3]
            if ahead.startswith("/*"):
                raise Refuse("uses a /* */ comment; use --")
            if ahead.startswith("//"):
                raise Refuse("uses a // comment, which snow and Snowflake read differently; use --")
            if ahead == "->>":
                raise Refuse("chains another statement with the ->> flow operator")
            if ahead[0] == "'":
                raise Refuse("has a string literal that isn't one plain line (no backslash, no line break)")
            if ahead[0] == "$":
                raise Refuse("uses $ (a variable, positional reference or $$ body)")
            raise Refuse(f"has {ahead[0]!r}, which none of the accepted statement shapes use")
        kind, text, i = m.lastgroup, m.group(0), m.end()
        if kind in ("ws", "comment"):
            continue
        if kind == "qid":
            if not PLAIN.match(text[1:-1]):
                raise Refuse(f"quotes a name that differs from its plain spelling ({text}); write it unquoted")
            toks.append(("id", text[1:-1]))
        elif kind == "id":
            toks.append(("id", text.upper()))
        else:
            toks.append((kind, text))
    if not toks or toks[-1] != ("sym", ";"):
        raise Refuse("doesn't end with ;")
    if ("sym", ";") in toks[:-1]:
        raise Refuse("holds more than one statement")
    return toks[:-1]


class P:
    """Recursive-descent reader over one statement's tokens; any mismatch refuses the statement."""

    def __init__(self, toks):
        self.t = toks
        self.i = 0

    def peek(self, k=0):
        return self.t[self.i + k] if self.i + k < len(self.t) else (None, None)

    def at(self, *words):
        return all(self.peek(k) == ("id", w) for k, w in enumerate(words))

    def eat(self, *words):
        if self.at(*words):
            self.i += len(words)
            return True
        return False

    def need(self, *words):
        if not self.eat(*words):
            raise Refuse(f"expected {' '.join(words)}")

    def sym(self, s):
        if self.peek() == ("sym", s):
            self.i += 1
            return True
        return False

    def word(self):
        k, v = self.peek()
        if k != "id":
            raise Refuse("expected a name")
        self.i += 1
        return v

    def name(self, max_parts=3):
        parts = [self.word()]
        while self.sym("."):
            parts.append(self.word())
        if len(parts) > max_parts:
            raise Refuse("a name has too many parts")
        return parts

    def done(self):
        if self.i != len(self.t):
            raise Refuse(f"has more after a complete statement ({self.peek()[1]!r})")

    def one_of(self, options):
        for opt in sorted(options, key=len, reverse=True):
            if self.eat(*opt):
                return opt
        return None

    def props(self, allowed):
        seen = set()
        while self.peek()[0] == "id":
            key = self.word()
            if key not in allowed or key in seen:
                raise Refuse(f"sets {key}, which isn't one of the properties accepted here")
            seen.add(key)
            if not self.sym("="):
                raise Refuse(f"expected = after {key}")
            kind, (k, v) = allowed[key], self.peek()
            if kind == "size":
                if v is None or v.strip("'").upper() not in WAREHOUSE_SIZES:
                    raise Refuse(f"{key} must be one of {', '.join(sorted(WAREHOUSE_SIZES))}")
                self.i += 1
            elif kind == "cluster":
                if k != "num" or not 1 <= int(v) <= MAX_CLUSTERS:
                    raise Refuse(f"{key} must be 1 to {MAX_CLUSTERS}")
                self.i += 1
            elif (kind, k) in (("str", "str"), ("num", "num"), ("word", "str")):
                self.i += 1
            elif kind == "bool" and (k, v) in (("id", "TRUE"), ("id", "FALSE")):
                self.i += 1
            elif kind in ("word", "name") and k == "id":
                named = self.name(1 if kind == "word" else 3)
                if key == "DEFAULT_ROLE" and named[-1] in SYSTEM_ROLES:
                    raise Refuse(f"sets DEFAULT_ROLE to system role {named[-1]}")
            elif kind == "empty" and self.sym("("):
                if not self.sym(")"):
                    raise Refuse(f"{key} may only be set to ()")
            elif kind == "strlist" and self.sym("("):
                while not self.sym(")"):
                    if self.peek()[0] != "str":
                        raise Refuse(f"{key} takes a list of strings")
                    self.i += 1
                    if not self.sym(",") and self.peek() != ("sym", ")"):
                        raise Refuse(f"{key} takes a list of strings")
            else:
                raise Refuse(f"{key} has a value of the wrong kind")


# --- shapes -------------------------------------------------------------------------------------------------------

class Ctx:
    def __init__(self, allowed: set[str], default_role: str) -> None:
        self.allowed = allowed
        self.role = default_role
        self.role_named = False
        self.database: str | None = None
        self.schema: str | None = None
        self.warehouse: str | None = None
        self.created_roles: set[str] = set()


def qualify(parts: list[str], ctx: Ctx, size: int) -> str:
    """A name filled out to `size` parts from the session context, as the server would resolve it."""
    fill = [ctx.database, ctx.schema][: size - 1]
    full = fill[: size - len(parts)] + parts if len(parts) < size else parts
    return ".".join(p or "?" for p in full)


def role_target(p: P) -> tuple[str, str]:
    """`ROLE x`, `USER x` or `DATABASE ROLE db.x`."""
    if p.eat("DATABASE", "ROLE"):
        n = p.name(2)
        if len(n) != 2:
            raise Refuse("a database role needs its database: db.role")
        return "database role", ".".join(n)
    if p.eat("ROLE"):
        return "role", p.name(1)[0]
    if p.eat("USER"):
        return "user", p.name(1)[0]
    raise Refuse("grants to something other than a role, database role or user")


def routine_signature(p: P) -> None:
    if not p.sym("("):
        raise Refuse("a procedure or function needs its argument types")
    first = True
    while not p.sym(")"):
        if not first and not p.sym(","):
            raise Refuse("argument types must be separated by commas")
        first = False
        p.word()
        if p.sym("("):
            while not p.sym(")"):
                if p.peek()[0] == "num":
                    p.i += 1
                elif not p.sym(","):
                    raise Refuse("an argument type has an unexpected size")


def object_target(p: P, ctx: Ctx, ownership: bool) -> str:
    which = "ALL" if p.eat("ALL") else "FUTURE" if p.eat("FUTURE") else None
    if which:
        plural = p.one_of(PLURALS)
        if not plural:
            raise Refuse("grants on a kind of object this lane doesn't accept")
        p.need("IN")
        if p.eat("SCHEMA"):
            if plural == ("SCHEMAS",):
                raise Refuse("SCHEMAS IN SCHEMA isn't a thing")
            where = qualify(p.name(2), ctx, 2)
        elif p.eat("DATABASE"):
            where = p.name(1)[0]
        else:
            raise Refuse("ALL or FUTURE needs IN SCHEMA or IN DATABASE")
        return f"{which} {' '.join(plural)} IN {where}"
    if ownership and p.eat("ROLE"):
        role = p.name(1)[0]
        if role not in ctx.created_roles:
            raise Refuse(f"moves ownership of role {role}, which this file did not create earlier; its owner could grant it anywhere")
        return f"ROLE {role}"
    routine = p.one_of(ROUTINES)
    if routine:
        name = qualify(p.name(3), ctx, 3)
        routine_signature(p)
        return f"{routine[0]} {name}"
    kind = p.one_of(OBJECT_TYPES)
    if not kind:
        raise Refuse("grants on a kind of object this lane doesn't accept (account, user, integration, share …)")
    return f"{' '.join(kind)} {qualify(p.name(OBJECT_TYPES[kind]), ctx, OBJECT_TYPES[kind])}"


def privileges(p: P) -> None:
    while True:
        if p.at("ALL"):
            raise Refuse("grants ALL, which covers privileges this lane refuses by name; list each privilege")
        if p.eat("CREATE"):
            if not p.one_of(CREATABLE):
                raise Refuse("grants a CREATE privilege this lane doesn't accept")
        elif p.peek()[1] in SINGLE_PRIVS and p.peek()[0] == "id":
            p.i += 1
        else:
            raise Refuse(f"grants {p.peek()[1]}, which isn't one of the privileges this lane accepts")
        if not p.sym(","):
            return


def check_grantee(kind: str, grantee: str) -> None:
    if kind == "role" and grantee in SYSTEM_ROLES:
        raise Refuse(f"grants to system role {grantee}")
    if kind == "database role" and grantee.endswith(".PUBLIC"):
        raise Refuse(f"grants to database role {grantee}, which every role in that database holds")


def use(p: P, ctx: Ctx) -> dict:
    if p.eat("SECONDARY", "ROLES"):
        p.need("NONE")
    elif p.eat("ROLE"):
        role = p.word()
        if role not in ctx.allowed:
            raise Refuse(f"USE ROLE {role} is not on this target's role list")
        ctx.role = role
        ctx.role_named = True
    elif p.eat("WAREHOUSE"):
        ctx.warehouse = p.word()
    elif p.eat("SCHEMA"):
        n = p.name(2)
        if len(n) == 2:
            ctx.database = n[0]
        ctx.schema = n[-1]
    else:
        p.eat("DATABASE")
        ctx.database, ctx.schema = p.word(), None
    p.done()
    return {"kind": "context"}


def create(p: P, ctx: Ctx) -> dict:
    if p.eat("ROLE"):
        exists = p.eat("IF", "NOT", "EXISTS")
        role = p.name(1)[0]
        p.props({"COMMENT": "str"})
        p.done()
        if role in SYSTEM_ROLES:
            raise Refuse(f"creates system role {role}")
        if not exists:
            ctx.created_roles.add(role)
        return {"kind": "create_role", "object": role}
    if p.eat("DATABASE", "ROLE"):
        p.eat("IF", "NOT", "EXISTS")
        n = p.name(2)
        if len(n) != 2:
            raise Refuse("a database role needs its database: db.role")
        p.props({"COMMENT": "str"})
        p.done()
        return {"kind": "create_object", "object": ".".join(n)}
    for word, kind, allowed in (("USER", "create_user", USER_PROPS), ("WAREHOUSE", "create_warehouse", WAREHOUSE_PROPS),
                                ("DATABASE", "create_database", CONTAINER_PROPS)):
        if p.eat(word):
            p.eat("IF", "NOT", "EXISTS")
            obj = p.name(1)[0]
            if word == "WAREHOUSE":
                p.eat("WITH")
            p.props(allowed)
            p.done()
            return {"kind": kind, "object": obj}
    for words, allowed in ((("STAGE",), STAGE_PROPS), (("FILE", "FORMAT"), FILE_FORMAT_PROPS)):
        if p.eat(*words):
            p.eat("IF", "NOT", "EXISTS")
            obj = qualify(p.name(3), ctx, 3)
            p.props(allowed)
            p.done()
            return {"kind": "create_object", "object": obj}
    if p.eat("SCHEMA"):
        p.eat("IF", "NOT", "EXISTS")
        sch = qualify(p.name(2), ctx, 2)
        p.eat("WITH", "MANAGED", "ACCESS")
        p.props(CONTAINER_PROPS)
        p.done()
        return {"kind": "create_object", "object": sch}
    raise Refuse("creates a kind of object this lane doesn't accept")


def grant_or_revoke(p: P, ctx: Ctx, grant: bool) -> dict:
    verb, to = ("grant", "TO") if grant else ("revoke", "FROM")
    if not grant and p.at("GRANT", "OPTION"):
        raise Refuse("REVOKE GRANT OPTION FOR isn't accepted")
    if p.at("ROLE") or p.at("DATABASE", "ROLE"):
        database_role = p.eat("DATABASE", "ROLE")
        if not database_role:
            p.need("ROLE")
        n = p.name(2 if database_role else 1)
        if database_role and len(n) != 2:
            raise Refuse("a database role needs its database: db.role")
        granted = ".".join(n)
        if granted in SYSTEM_ROLES:
            raise Refuse(f"{verb}s system role {granted}")
        p.need(to)
        kind, grantee = role_target(p)
        p.done()
        if not database_role and kind == "database role":
            raise Refuse("grants an account role to a database role")
        rec = {"kind": verb, "grantee": grantee, "granted": granted, "grantee_kind": kind}
        if grant and not database_role and kind == "role" and grantee == "SYSADMIN":
            rec["rollup"] = granted
            rec["created_before"] = granted in ctx.created_roles
            return rec
        check_grantee(kind, grantee)
        return rec
    if grant and p.eat("OWNERSHIP"):
        p.need("ON")
        obj = object_target(p, ctx, ownership=True)
        p.need("TO")
        kind, grantee = role_target(p)
        if kind == "user":
            raise Refuse("ownership goes to a role, not a user")
        drops = p.eat("REVOKE", "CURRENT", "GRANTS")
        if not drops:
            p.eat("COPY", "CURRENT", "GRANTS")
        p.done()
        check_grantee(kind, grantee)
        return {"kind": "ownership", "grantee": grantee, "object": obj, "drops_grants": drops, "grantee_kind": kind}
    privileges(p)
    p.need("ON")
    obj = object_target(p, ctx, ownership=False)
    p.need(to)
    kind, grantee = role_target(p)
    if kind == "user":
        raise Refuse("object privileges go to a role, not a user")
    if grant and p.at("WITH"):
        raise Refuse("WITH GRANT OPTION isn't accepted")
    if not grant and not p.eat("CASCADE"):
        p.eat("RESTRICT")
    p.done()
    check_grantee(kind, grantee)
    return {"kind": verb, "grantee": grantee, "object": obj, "grantee_kind": kind}


# --- data statements ------------------------------------------------------------------------------------------
# CREATE TABLE / VIEW / DYNAMIC TABLE, MERGE and SELECT carry expressions the shapes above never parse. Their bodies
# are scanned, not parsed: a wider symbol set, with every hard refusal above kept, and a list of words that would make
# the statement do something other than create, fill or read its one object.

BODY_TOKEN = re.compile(r"""
    (?P<ws>[ \t\n]+)
  | (?P<comment>--[^\n]*)
  | (?P<str>'(?:[^'\\\n]|'')*')
  | (?P<qid>"(?:[^"\n]|"")*")
  | (?P<id>[A-Za-z_][A-Za-z0-9_$]*)
  | (?P<num>[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)
  | (?P<sym>[.,()=;*:+\-<>!|%/])
""", re.X)
DATA_START = re.compile(
    r"^\s*(?:--[^\n]*\n\s*)*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|DYNAMIC\s+TABLE)|MERGE|SELECT|WITH)\b", re.I)
# Statements, session changes and data movement a body may not hold, whatever else it does.
BODY_DENY = {"CALL", "EXECUTE", "IMMEDIATE", "COPY", "PUT", "GET", "LIST", "REMOVE", "USE", "UNSET", "BEGIN",
             "COMMIT", "ROLLBACK", "CREATE", "DROP", "ALTER", "GRANT", "REVOKE", "TRUNCATE", "UNDROP", "IDENTIFIER",
             "CLONE"}
# SET appears in a MERGE only as UPDATE SET; anywhere else it would be a session change.
WRITES = {"INSERT", "UPDATE", "DELETE", "MERGE", "SET"}
LITERAL_WORDS = {"NULL", "TRUE", "FALSE"}
# The only names a data statement's body may call: built-ins that read or compute and change nothing. Anything else
# (a user-defined or external function, a procedure through TABLE(…), TO_QUERY, a SNOWFLAKE.* service, a method) is
# refused. Growing the list is one line here and one row in the suite.
FUNCTIONS = frozenset("""
    COUNT COUNT_IF SUM MIN MAX AVG MEDIAN MODE STDDEV ANY_VALUE APPROX_COUNT_DISTINCT LISTAGG ARRAY_AGG OBJECT_AGG
    BOOLAND_AGG BOOLOR_AGG
    ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE PERCENT_RANK CUME_DIST RATIO_TO_REPORT
    CURRENT_TIMESTAMP CURRENT_DATE CURRENT_TIME CURRENT_USER CURRENT_ROLE CURRENT_DATABASE CURRENT_SCHEMA
    CURRENT_WAREHOUSE SYSDATE GETDATE LOCALTIMESTAMP
    CAST TRY_CAST TO_DATE TO_TIMESTAMP TO_TIMESTAMP_NTZ TO_TIMESTAMP_LTZ TO_TIMESTAMP_TZ TO_VARCHAR TO_CHAR TO_NUMBER
    TO_DECIMAL TO_DOUBLE TO_BOOLEAN TO_VARIANT TO_ARRAY TO_OBJECT TRY_TO_DATE TRY_TO_TIMESTAMP TRY_TO_NUMBER
    TRY_TO_BOOLEAN PARSE_JSON TRY_PARSE_JSON
    DATE TO_TIME DATEADD DATEDIFF DATE_TRUNC DATE_PART EXTRACT YEAR MONTH DAY DAYOFWEEK WEEK QUARTER LAST_DAY TIMESTAMPADD
    TIMESTAMPDIFF CONVERT_TIMEZONE DATE_FROM_PARTS TIMESTAMP_FROM_PARTS
    UPPER LOWER TRIM LTRIM RTRIM SUBSTR SUBSTRING LENGTH LEN CONCAT CONCAT_WS REPLACE SPLIT SPLIT_PART STRTOK LPAD
    RPAD LEFT RIGHT INITCAP POSITION CHARINDEX CONTAINS STARTSWITH ENDSWITH REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR
    REGEXP_COUNT REGEXP_INSTR RLIKE INSERT REVERSE TRANSLATE EDITDISTANCE ASCII CHR COLLATE
    ROUND ABS CEIL FLOOR TRUNC MOD POWER SQRT LN LOG EXP SIGN DIV0 DIV0NULL GREATEST LEAST
    COALESCE IFF IFNULL NVL NVL2 NULLIF NULLIFZERO ZEROIFNULL DECODE EQUAL_NULL
    OBJECT_CONSTRUCT OBJECT_CONSTRUCT_KEEP_NULL ARRAY_CONSTRUCT ARRAY_SIZE ARRAY_CONTAINS ARRAY_TO_STRING ARRAY_SLICE
    ARRAY_DISTINCT OBJECT_KEYS GET_PATH IS_NULL_VALUE TYPEOF AS_VARCHAR AS_NUMBER STRIP_NULL_VALUE
    HASH MD5 SHA1 SHA2 UUID_STRING
    FLATTEN GENERATOR SPLIT_TO_TABLE STRTOK_SPLIT_TO_TABLE SEQ4 SEQ8 UNIFORM RANDOM
""".split())
# Reserved words that take a parenthesised list. Being reserved, none can name a function.
PAREN_KEYWORDS = frozenset("""
    IN EXISTS VALUES AS FROM ON AND OR NOT THEN ELSE SELECT WHERE HAVING QUALIFY BY UNIQUE GROUP ALL ANY SOME
    DISTINCT LIKE ILIKE TABLE
""".split())
# Types that take a size, in a column list or a :: cast.
PAREN_TYPES = frozenset("""
    NUMBER DECIMAL NUMERIC VARCHAR CHAR CHARACTER STRING TEXT BINARY VARBINARY TIMESTAMP TIMESTAMP_NTZ
    TIMESTAMP_LTZ TIMESTAMP_TZ TIME DATETIME FLOAT DOUBLE VECTOR
""".split())
# A VALUES list longer than this is shown as its first and last rows; every row must then be a literal.
SHOWN_ROWS = 3


VIEW_PROPS = {"COMMENT": "str"}
DYNAMIC_PROPS = {"COMMENT": "str", "TARGET_LAG": "str", "WAREHOUSE": "name", "REFRESH_MODE": "word",
                 "INITIALIZE": "word"}


def view_header(p: P, allowed: dict) -> None:
    """The clauses between a view's or dynamic table's name and its AS query; the query is scanned after it. An optional
    column list comes first: names, each with an optional COMMENT '...', and nothing else."""
    if p.sym("("):
        while True:
            if p.peek()[0] != "id":
                raise Refuse("has a column list holding something other than names and COMMENTs")
            p.i += 1
            if p.eat("COMMENT"):
                if p.peek()[0] != "str":
                    raise Refuse("has a column COMMENT that isn't a string")
                p.i += 1
            if p.sym(")"):
                break
            if not p.sym(","):
                raise Refuse("has a column list holding something other than names and COMMENTs")
    seen = set()
    while not p.eat("AS"):
        if p.eat("COPY", "GRANTS"):
            continue
        key = p.word() if p.peek()[0] == "id" else None
        if key not in allowed or key in seen or not p.sym("="):
            raise Refuse("has a clause before its AS query this lane doesn't accept" if key else "has no AS query")
        seen.add(key)
        kind, (k, _) = allowed[key], p.peek()
        if (kind, k) in (("str", "str"), ("word", "id"), ("word", "str")):
            p.i += 1
        elif kind == "name" and k == "id":
            p.name(1)
        else:
            raise Refuse(f"{key} has a value of the wrong kind")


def tokenize_body(stmt: str) -> list[tuple[str, str, int, int]]:
    refuse_unplain(stmt)
    toks, i = [], 0
    while i < len(stmt):
        ahead = stmt[i:i + 3]
        if ahead.startswith("/*"):
            raise Refuse("uses a /* */ comment; use --")
        if ahead.startswith("//"):
            raise Refuse("uses a // comment, which snow and Snowflake read differently; use --")
        if ahead == "->>":
            raise Refuse("chains another statement with the ->> flow operator")
        m = BODY_TOKEN.match(stmt, i)
        if not m:
            if ahead[0] == "'":
                raise Refuse("has a string literal that isn't one plain line (no backslash, no line break)")
            if ahead[0] == "$":
                raise Refuse("uses $ (a variable, positional reference or $$ body)")
            raise Refuse(f"has {ahead[0]!r}, which none of the accepted statement shapes use")
        kind, text, start, i = m.lastgroup, m.group(0), m.start(), m.end()
        if kind in ("ws", "comment"):
            continue
        if kind == "qid":
            if not PLAIN.match(text[1:-1]):
                raise Refuse(f"quotes a name that differs from its plain spelling ({text}); write it unquoted")
            toks.append(("id", text[1:-1], start, i))
        elif kind == "id":
            toks.append(("id", text.upper(), start, i))
        else:
            toks.append((kind, text, start, i))
    if not toks or toks[-1][:2] != ("sym", ";"):
        raise Refuse("doesn't end with ;")
    if any(t[:2] == ("sym", ";") for t in toks[:-1]):
        raise Refuse("holds more than one statement")
    return toks[:-1]


def scan_body(toks, writes: bool) -> None:
    for k, (kind, text, _, _) in enumerate(toks):
        if kind != "id":
            continue
        if text.startswith("SYSTEM$"):
            raise Refuse(f"calls {text}, a system function this lane doesn't run")
        if text in BODY_DENY or (not writes and text in WRITES):
            raise Refuse(f"holds {text}, which this kind of statement may not")


def literal_row(toks) -> bool:
    """( literal , literal … ): strings, numbers (optionally negative), NULL, TRUE, FALSE, nothing else."""
    if len(toks) < 3 or toks[0][:2] != ("sym", "(") or toks[-1][:2] != ("sym", ")"):
        return False
    inner, i, want_value = toks[1:-1], 0, True
    while i < len(inner):
        kind, text = inner[i][:2]
        if want_value:
            if (kind, text) == ("sym", "-") and i + 1 < len(inner) and inner[i + 1][0] == "num":
                i += 1
            elif not (kind in ("str", "num") or (kind == "id" and text in LITERAL_WORDS)):
                return False
        elif (kind, text) != ("sym", ","):
            return False
        want_value = not want_value
        i += 1
    return not want_value


def values_rows(toks, at: int) -> list[tuple[int, int]]:
    """The rows of the VALUES list whose keyword is toks[at], as (first, last) token indexes."""
    rows, i = [], at + 1
    while i < len(toks) and toks[i][:2] == ("sym", "("):
        depth, j = 0, i
        while j < len(toks):
            if toks[j][:2] == ("sym", "("):
                depth += 1
            elif toks[j][:2] == ("sym", ")"):
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j == len(toks):
            raise Refuse("has a VALUES row that never closes")
        rows.append((i, j))
        if j + 1 < len(toks) and toks[j + 1][:2] == ("sym", ",") and j + 2 < len(toks) and toks[j + 2][:2] == ("sym", "("):
            i = j + 2
        else:
            break
    return rows


def collapse_values(stmt: str, toks) -> tuple[str, list[dict]]:
    """The statement as a card shows it, with each long VALUES list cut to its first and last rows, and what was cut.
    Only a VALUES list is ever cut, and only one whose every row is a literal."""
    display, collapsed, cursor = [], [], 0
    for at, tok in enumerate(toks):
        if tok[:2] != ("id", "VALUES"):
            continue
        rows = values_rows(toks, at)
        if len(rows) <= 2 * SHOWN_ROWS:
            continue
        if not all(literal_row(toks[a:b + 1]) for a, b in rows):
            raise Refuse("has a long VALUES list with a row that isn't only literals")
        first, last = toks[rows[0][0]][2], toks[rows[-1][1]][3]
        head_end = toks[rows[SHOWN_ROWS - 1][1]][3]
        tail_start = toks[rows[-SHOWN_ROWS][0]][2]
        hidden = len(rows) - 2 * SHOWN_ROWS
        display.append(stmt[cursor:head_end])
        display.append(f",\n    … {hidden} more rows …,\n    ")
        display.append(stmt[tail_start:last])
        cursor = last
        cut = stmt[first:last]
        collapsed.append({"rows": len(rows), "sha256": hashlib.sha256(cut.encode()).hexdigest()})
    display.append(stmt[cursor:])
    return "".join(display), collapsed


def merge_actions(stmt: str, toks) -> list[str]:
    """What each WHEN clause of a MERGE does to the target's rows, in order: INSERT, UPDATE <n> column(s), DELETE.
    THEN, INSERT, UPDATE and DELETE are reserved words, so unquoted they can only be clause syntax or, for INSERT, the
    string function; CASE and END are not reserved, so nesting is never inferred from them. An INSERT is the string
    function only when a parenthesised list follows it with no VALUES after; every other INSERT is a row insert.
    Every row write must be some THEN's action."""
    def word(k: int) -> str | None:
        kind, text, start, _ = toks[k] if k < len(toks) else (None, None, 0, 0)
        return text if kind == "id" and stmt[start] != '"' else None

    def sym(k: int) -> str | None:
        return toks[k][1] if k < len(toks) and toks[k][0] == "sym" else None

    def after_parens(k: int) -> int:
        depth = 0
        for j in range(k, len(toks)):
            depth += {"(": 1, ")": -1}.get(sym(j) or "", 0)
            if depth == 0:
                return j + 1
        return len(toks)

    def row_insert(k: int) -> bool:
        return sym(k + 1) != "(" or word(after_parens(k + 1)) == "VALUES"

    verbs = [k for k in range(len(toks)) if word(k) in ("UPDATE", "DELETE") or (word(k) == "INSERT" and row_insert(k))]
    if not verbs:
        raise Refuse("is a MERGE with no WHEN … THEN clause")
    if any(word(k - 1) != "THEN" for k in verbs):
        raise Refuse("has INSERT, UPDATE or DELETE somewhere other than a MERGE's WHEN … THEN")
    actions = []
    for n, k in enumerate(verbs):
        if word(k) != "UPDATE":
            actions.append(word(k))
            continue
        if word(k + 1) != "SET":
            raise Refuse("has a MERGE UPDATE without SET")
        end = verbs[n + 1] if n + 1 < len(verbs) else len(toks)
        columns, depth = 1, 0
        for j in range(k + 2, end):
            depth += {"(": 1, ")": -1}.get(sym(j) or "", 0)
            if depth == 0 and sym(j) == "," and toks[j + 1][0] == "id":
                m = j + 2
                while sym(m) == "." and m + 1 < end and toks[m + 1][0] == "id":
                    m += 2
                columns += sym(m) == "="
        actions.append(f"UPDATE {columns} column" + ("s" if columns > 1 else ""))
    return actions


def unlisted_call(stmt: str, toks, create_table: bool, merge_using: int | None = None) -> str | None:
    """The first name the body calls that isn't a listed built-in. A built-in can't share a name with a user-defined
    function, so a bare, unquoted FUNCTIONS entry is safe anywhere; a word that isn't reserved could name one, so it
    passes only where the grammar makes it something other than a call."""
    def tok(k: int) -> tuple:
        return toks[k][:2] if 0 <= k < len(toks) else (None, None)

    def after_close(k: int) -> int:
        depth = 0
        for j in range(k, len(toks)):
            depth += {("sym", "("): 1, ("sym", ")"): -1}.get(tok(j), 0)
            if depth == 0:
                return j + 1
        return len(toks)

    def not_a_call(k: int, name: str) -> bool:
        prev, prev2 = tok(k - 2), tok(k - 3)
        expression_end = prev[0] in ("num", "str") or prev == ("sym", ")") or (
            prev[0] == "id" and prev[1] not in PAREN_KEYWORDS and prev[1] not in ("CASE", "WHEN", "SET"))
        subquery = tok(k + 1) in (("id", "SELECT"), ("id", "WITH"))
        close = after_close(k)
        names_only = close - k > 2 and all(
            tok(j)[0] == "id" if (j - k) % 2 else tok(j) == ("sym", ",") for j in range(k + 1, close - 1))
        column_def = create_table and prev2 in (("sym", "("), ("sym", ",")) and prev[0] == "id"
        if name in FUNCTIONS or name in PAREN_KEYWORDS:
            return True
        if name in PAREN_TYPES:
            return (prev == ("sym", ":") and prev2 == ("sym", ":")) or prev == ("id", "AS") or column_def
        rules = {
            "OVER": prev == ("sym", ")"),
            "KEY": prev in (("id", "PRIMARY"), ("id", "FOREIGN")),
            "WHEN": prev == ("id", "CASE") or expression_end,
            "JOIN": subquery, "LATERAL": subquery,
            "USING": k - 1 == merge_using,
        }
        if name in rules:
            return rules[name]
        cte_columns = prev in (("id", "WITH"), ("sym", ",")) and tok(close) == ("id", "AS") \
            and tok(close + 1) == ("sym", "(")
        derived_alias = prev == ("sym", ")") or (prev == ("id", "AS") and prev2 == ("sym", ")"))
        return names_only and (cte_columns or derived_alias)

    for k in range(1, len(toks)):
        if toks[k][:2] != ("sym", "(") or toks[k - 1][0] != "id":
            continue
        _, name, start, _ = toks[k - 1]
        if stmt[start] == '"':
            return f'"{name}"'
        if tok(k - 2) not in (("sym", "."), ("sym", "!")) and not_a_call(k, name):
            continue
        m = k - 1
        while m >= 2 and toks[m - 1][:2] == ("sym", ".") and toks[m - 2][0] == "id":
            m -= 2
        if create_table and m >= 1 and toks[m - 1][:2] == ("id", "REFERENCES"):
            continue
        return ".".join(t[1] for t in toks[m:k:2])
    return None


# Snowflake's reserved and limited keywords, plus clause words that aren't reserved; none may stand as an alias, or a
# keyword followed by a parenthesised name (JOIN (T), LATERAL (T)) would pass as an alias and its column list.
NOT_ALIASES = frozenset("""
    ACCOUNT ALL ALTER AND ANY AS BETWEEN BY CASE CAST CHECK COLUMN CONNECT CONNECTION CONSTRAINT CREATE CROSS CURRENT
    CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DATABASE DELETE DISTINCT DROP ELSE EXISTS FALSE FOLLOWING
    FOR FROM FULL GRANT GROUP GSCLUSTER HAVING ILIKE IN INCREMENT INNER INSERT INTERSECT INTO IS ISSUE JOIN LATERAL LEFT
    LIKE LOCALTIME LOCALTIMESTAMP MINUS NATURAL NOT NULL OF ON OR ORDER ORGANIZATION QUALIFY REGEXP REVOKE RIGHT RLIKE
    ROW ROWS SAMPLE SCHEMA SELECT SET SOME START TABLE TABLESAMPLE THEN TO TRIGGER TRUE TRY_CAST UNION UNIQUE UPDATE
    USING VALUES VIEW WHEN WHENEVER WHERE WINDOW WITH
    EXCEPT PIVOT UNPIVOT MATCH_RECOGNIZE CHANGES AT BEFORE LIMIT OFFSET FETCH
""".split())


def merge_sources(toks, ctx: Ctx) -> tuple[list[str], int]:
    """What a MERGE reads besides its target; a MERGE that reads a stream consumes it. Only a subquery lets a MERGE read
    a table other than the one named after USING, so two forms are accepted: USING <table> with no SELECT or WITH
    anywhere, or a USING that is a VALUES list, bare or under one SELECT with one FROM, which reads nothing. Every
    other form is refused rather than parsed. Also returns the USING keyword's index."""
    def tok(k: int) -> tuple:
        return toks[k][:2] if 0 <= k < len(toks) else (None, None)

    def close_of(k: int) -> int:
        depth = 0
        for j in range(k, len(toks)):
            depth += {("sym", "("): 1, ("sym", ")"): -1}.get(tok(j), 0)
            if depth == 0:
                return j
        raise Refuse("is a MERGE with a parenthesis that never closes")

    def after_alias(k: int) -> int:
        """Past an optional [AS] alias [(column, …)] starting at k."""
        if tok(k) == ("id", "AS"):
            k += 1
        if tok(k)[0] == "id" and tok(k)[1] not in NOT_ALIASES:
            k += 1
            if tok(k) == ("sym", "("):
                c = close_of(k)
                if c == k + 1 or not all(
                        tok(j)[0] == "id" if (j - k) % 2 else tok(j) == ("sym", ",") for j in range(k + 1, c)):
                    raise Refuse("is a MERGE whose alias column list holds something other than names")
                k = c + 1
        return k

    def values_end(k: int) -> int:
        """Past the VALUES list whose keyword is toks[k]."""
        rows = values_rows(toks, k)
        if not rows:
            raise Refuse("is a MERGE with a VALUES keyword and no rows")
        return rows[-1][1] + 1

    other = "is a MERGE whose USING is neither one table name nor a VALUES list"
    subquery = "is a MERGE with a subquery; it may read only the table named after USING, or a VALUES list"
    using = after_alias(0)
    if tok(using) != ("id", "USING"):
        raise Refuse(other)
    selects = [k for k in range(len(toks)) if tok(k) in (("id", "SELECT"), ("id", "WITH"))]
    if any(tok(k) == ("sym", "(") and tok(k + 1) in (("id", "FROM"), ("id", "TABLE")) for k in range(len(toks))):
        raise Refuse(subquery)
    k = using + 1
    if tok(k) == ("sym", "("):
        c, i = close_of(k), k + 1
        if tok(i) == ("id", "VALUES"):
            inner_end, allowed = values_end(i), []
        elif tok(i) == ("id", "SELECT"):
            if sum(tok(j) == ("id", "FROM") for j in range(i, c)) != 1:
                raise Refuse(subquery)
            depth, f = 0, None
            for j in range(i + 1, c):
                depth += {("sym", "("): 1, ("sym", ")"): -1}.get(tok(j), 0)
                if depth == 0 and tok(j) == ("id", "FROM"):
                    f = j
                    break
            if f is not None and tok(f + 1) == ("id", "VALUES"):
                inner_end = after_alias(values_end(f + 1))
            elif f is not None and tok(f + 1) == ("sym", "(") and tok(f + 2) == ("id", "VALUES"):
                cc = close_of(f + 1)
                if values_end(f + 2) != cc:
                    raise Refuse(subquery)
                inner_end = after_alias(cc + 1)
            else:
                raise Refuse(subquery)
            allowed = [i]
        else:
            raise Refuse(subquery)
        if inner_end != c or selects != allowed:
            raise Refuse(subquery)
        sources, k = [], c + 1
    else:
        if tok(k)[0] != "id" or tok(k)[1] in ("VALUES", "SELECT", "WITH", "LATERAL"):
            raise Refuse(other)
        parts, k = [tok(k)[1]], k + 1
        while tok(k) == ("sym", ".") and tok(k + 1)[0] == "id":
            parts.append(tok(k + 1)[1])
            k += 2
        if selects:
            raise Refuse(subquery)
        sources = [qualify(parts, ctx, 3)]
    if tok(after_alias(k)) != ("id", "ON"):
        raise Refuse(other)
    return sources, using


def data_shape(stmt: str, ctx: Ctx) -> dict:
    toks = tokenize_body(stmt)
    p = P([t[:2] for t in toks])
    rec: dict = {}
    header = len(toks)
    if p.eat("CREATE"):
        replaces = p.eat("OR", "REPLACE")
        if p.eat("TABLE"):
            if replaces:
                raise Refuse("is CREATE OR REPLACE TABLE, which drops the table and its data")
            p.eat("IF", "NOT", "EXISTS")
            obj = qualify(p.name(3), ctx, 3)
            if p.peek() != ("sym", "("):
                raise Refuse("creates a table some way other than from a column list (CLONE, LIKE, AS SELECT, USING TEMPLATE)")
            if any(t[:2] == ("id", "SELECT") for t in toks[p.i:]):
                raise Refuse("creates a table that reads data while it is made")
            rec = {"kind": "create_table", "object": obj}
            writes = False
        else:
            kind = "create_dynamic_table" if p.eat("DYNAMIC", "TABLE") else "create_view" if p.eat("VIEW") else None
            if kind is None:
                raise Refuse("creates a kind of object this lane doesn't accept")
            p.eat("IF", "NOT", "EXISTS")
            obj = qualify(p.name(3), ctx, 3)
            header = p.i
            view_header(p, DYNAMIC_PROPS if kind == "create_dynamic_table" else VIEW_PROPS)
            rec = {"kind": kind, "object": obj, "replaces": replaces}
            writes = False
    elif p.eat("MERGE", "INTO"):
        rec = {"kind": "merge", "object": qualify(p.name(3), ctx, 3), "actions": merge_actions(stmt, toks[p.i:])}
        writes = True
    elif p.at("SELECT") or p.at("WITH"):
        rec = {"kind": "select"}
        writes = False
    else:
        raise Refuse("is not one of the statement shapes this lane accepts")
    if "?" in (rec.get("object") or ""):
        raise Refuse("names an object without its database and schema, and no USE sets them")
    if any(part in BODY_DENY or part == "TABLE" for part in (rec.get("object") or "").split(".")):
        raise Refuse("names its object through IDENTIFIER or TABLE, so the schema it writes in can't be read")
    scan_body(toks[p.i:], writes)
    if rec["kind"] != "create_table" and any(t[:2] == ("id", "NEXTVAL") for t in toks[p.i:]):
        raise Refuse("takes a sequence's NEXTVAL, which uses up values even when only read")
    quoted = next((t[1] for t in toks[min(header, p.i):] if t[0] == "id" and stmt[t[2]] == '"'), None)
    if quoted:
        raise Refuse(f'quotes "{quoted}", which reads the same unquoted; quoting here only disguises a keyword')
    display, collapsed = collapse_values(stmt, toks)
    merge_using = None
    if rec["kind"] == "merge":
        rec["sources"], merge_using = merge_sources(toks[p.i:], ctx)
    called = unlisted_call(stmt, toks[p.i:], rec["kind"] == "create_table", merge_using)
    if called:
        raise Refuse(f"calls {called}, which isn't on the lane's list of built-in functions")
    if collapsed:
        rec.update(display=display, collapsed=collapsed)
    return rec


def shape(stmt: str, ctx: Ctx) -> dict:
    if DATA_START.match(stmt):
        return data_shape(stmt, ctx)
    p = P(tokenize(stmt))
    if p.eat("USE"):
        return use(p, ctx)
    if p.eat("SHOW"):
        while p.peek()[0] is not None:
            if p.peek()[0] not in ("id", "str") and p.peek() != ("sym", "."):
                raise Refuse("SHOW takes only names, LIKE '…' and IN …")
            p.i += 1
        return {"kind": "read_metadata"}
    if p.eat("CREATE"):
        return create(p, ctx)
    if p.eat("ALTER", "SCHEMA"):
        sch = qualify(p.name(2), ctx, 2)
        p.need("ENABLE", "MANAGED", "ACCESS")
        p.done()
        return {"kind": "alter", "object": sch}
    if p.eat("GRANT"):
        return grant_or_revoke(p, ctx, True)
    if p.eat("REVOKE"):
        return grant_or_revoke(p, ctx, False)
    raise Refuse("is not one of the statement shapes this lane accepts")


def fact(stmt: str, ctx: Ctx) -> dict:
    rec: dict = {"text": stmt, "scope": "none"}
    squeezed = re.sub(r"[\s'\"|+]", "", stmt.upper())
    if FORBIDDEN.search(squeezed):
        rec.update(kind="forbidden_role", deny="names ACCOUNTADMIN or ORGADMIN")
    elif LANE_OWN.search(squeezed):
        rec.update(kind="lane_own", deny="names one of the approved-run lane's own objects (APPROVED_RUN_*)")
    else:
        try:
            rec.update(shape(stmt, ctx))
        except Refuse as e:
            rec.update(kind="refused", deny=f"this statement {e}")
    if rec.get("kind") in ("grant", "revoke", "ownership") and not ctx.role_named:
        rec["role_unnamed"] = "REVOKE" if rec["kind"] == "revoke" else "GRANT"
    rec.update(role=ctx.role, database=ctx.database, schema=ctx.schema, warehouse=ctx.warehouse)
    return rec


def settle_rollups(facts: list[dict]) -> None:
    """The one grant into a system role: GRANT ROLE r TO ROLE SYSADMIN, where this file created r and grants nothing
    else into it, so SYSADMIN gains exactly an empty role."""
    received = {f.get("grantee") for f in facts
                if f.get("kind") in ("grant", "ownership") and f.get("grantee_kind") == "role" and "rollup" not in f}
    for f in facts:
        r = f.pop("rollup", None)
        created_before = f.pop("created_before", False)
        if r is None or f.get("deny"):
            continue
        if not created_before:
            f["deny"] = f"this statement grants to SYSADMIN a role ({r}) not created earlier in this file without IF NOT EXISTS"
        elif r in received:
            f["deny"] = f"this statement rolls {r} up to SYSADMIN after the file grants something into {r}"


def require_named_role(facts: list[dict]) -> None:
    """Runs after every other check, so a statement they refuse keeps their reason. The target's default role is
    chosen for creating roles and users, not for reaching every object: a grant left on it fails at run time on any
    database that role cannot see, after the owner has already approved it."""
    for f in facts:
        verb = f.pop("role_unnamed", None)
        if verb and not f.get("deny"):
            f["deny"] = f"this statement needs a USE ROLE before it; without one this {verb} would run as the default role {f['role']}"


def facts_for(text: str, allowed: set[str], default_role: str | None) -> list[dict]:
    if not default_role or default_role in {"ACCOUNTADMIN", "ORGADMIN"} or not PLAIN.match(default_role):
        raise Refuse("the target names no usable default role")
    split = load_splitter()
    ctx = Ctx(allowed | {default_role}, default_role)
    facts = [fact(s, ctx) for s in snow_statements(split, text)]
    settle_rollups(facts)
    require_named_role(facts)
    runs = [f for f in facts if f.get("kind") != "context" and not f.get("deny")]
    for f, sent in zip(runs, snow_sends([f["text"] for f in runs])):
        if sent.get("final") != [SESSION_SQL.strip(), f["text"].strip(" \t\n\r")] or sent.get("errors"):
            f["deny"] = "snow would send something other than this exact statement"
    return facts


def refuse_all(reason: str) -> list[dict]:
    return [{"text": "", "kind": "refused", "scope": "none", "role": None, "database": None,
             "schema": None, "warehouse": None, "deny": reason}]


def main(argv: list[str]) -> None:
    args = list(argv)
    emit_facts = "--facts" in args
    opts = {}
    for flag in ("--allowed-roles", "--default-role", "--snow-root"):
        if flag in args:
            i = args.index(flag)
            opts[flag] = args[i + 1]
            del args[i:i + 2]
    configure(opts.get("--snow-root", ""))
    allowed = {r for r in opts.get("--allowed-roles", "").split(",") if r} - {"ACCOUNTADMIN", "ORGADMIN"}
    files = [a for a in args if not a.startswith("--")]

    def run(path: str) -> list[dict]:
        # newline="" keeps a lone CR for the tokenizer to refuse; CRLF is the one line ending normalised, as snow would.
        with open(path, encoding="utf-8", errors="strict", newline="") as f:
            text = f.read().replace("\r\n", "\n")
        try:
            return facts_for(text, allowed, opts.get("--default-role"))
        except Refuse as e:
            return refuse_all(str(e))

    if emit_facts:
        if len(files) != 1:
            sys.exit("--facts takes exactly one file")
        json.dump({"runner": RUNNER, "pins": PINS, "statements": run(files[0])}, sys.stdout)
    else:
        for f in files:
            fs = run(f)
            denies = [x for x in fs if x.get("deny")]
            print(f"{len(fs):4} stmts  {len(denies):3} denied  {f}")
            for d in denies[:5]:
                print(f"      DENY {d['deny'][:70]} | {' '.join(d['text'].split())[:80]}")


if __name__ == "__main__":
    main(sys.argv[1:])
