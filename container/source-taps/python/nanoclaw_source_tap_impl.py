"""Records each read statement a Snowflake cursor runs to the container's source ledger.

Imported by nanoclaw_source_tap, through a .pth in each interpreter's site dir, when recording is on. A script that
queries Snowflake directly is recorded the same as `snow sql`, which runs through the same cursor. It patches the cursor
class only when the connector is imported and never raises into the caller. An async submission counts once it is
accepted; its later outcome is not observed.
"""

import os
import sys

_LEDGER = os.environ.get("NANOCLAW_SOURCE_LEDGER") or "/tmp/nanoclaw-sources/ledger.jsonl"
_MAX_LEDGER_BYTES = 256 * 1024 * 1024
_MAX_SQL_CHARS = 200000
_READ_PATTERN = r"^(?:\s|--[^\n]*\n|/\*.*?\*/|\()*(select|with)\b"
_TARGETS = ("snowflake.connector.cursor", "snowflake.connector.aio._cursor")


def _statements(sql):
    """Top-level statements, split on `;` outside comments, string literals and quoted identifiers."""
    parts, start, i, n = [], 0, 0, len(sql)
    while i < n:
        c, nxt = sql[i], sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":
            end = sql.find("\n", i)
            i = n if end == -1 else end
        elif c == "/" and nxt == "*":
            end = sql.find("*/", i + 2)
            i = n if end == -1 else end + 2
        elif c == "$" and nxt == "$":
            end = sql.find("$$", i + 2)
            i = n if end == -1 else end + 2
        elif c in ("'", '"'):
            j = i + 1
            while j < n:
                if c == "'" and sql[j] == "\\":
                    j += 2
                elif sql[j] == c and j + 1 < n and sql[j + 1] == c:
                    j += 2
                elif sql[j] == c:
                    break
                else:
                    j += 1
            i = j + 1
        elif c == ";":
            parts.append(sql[start:i])
            start = i + 1
            i += 1
        else:
            i += 1
    parts.append(sql[start:])
    return [p for p in parts if p.strip()]


def _record(sql, ok):
    try:
        # Imported on first use: this module loads in every Python process, most of which never touch Snowflake.
        import datetime
        import json
        import re

        # A batch (num_statements) is recorded when any statement in it is a read, judged on the whole text before
        # any cut.
        if not isinstance(sql, str) or not any(
            re.match(_READ_PATTERN, part, re.IGNORECASE | re.DOTALL) for part in _statements(sql)
        ):
            return
        try:
            if os.path.getsize(_LEDGER) > _MAX_LEDGER_BYTES:
                return
        except OSError:
            pass
        os.makedirs(os.path.dirname(_LEDGER), exist_ok=True)
        entry = {
            "v": 1,
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "recorder": "snowflake",
            "sql": sql[:_MAX_SQL_CHARS],
            "truncated": len(sql) > _MAX_SQL_CHARS,
            "ok": bool(ok),
            "process": os.path.basename(sys.argv[0]) if sys.argv and sys.argv[0] else "python",
        }
        line = (json.dumps(entry) + "\n").encode("utf-8")
        fd = os.open(_LEDGER, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, line)
        finally:
            os.close(fd)
    except Exception:
        pass


def _command_of(args, kwargs):
    return kwargs.get("command", args[0] if args else None)


def _wrap_sync(execute):
    def execute_recorded(self, *args, **kwargs):
        # describe() runs execute(_describe_only=True): metadata, never rows.
        if kwargs.get("_describe_only"):
            return execute(self, *args, **kwargs)
        sql = _command_of(args, kwargs)
        try:
            result = execute(self, *args, **kwargs)
        except BaseException:
            _record(sql, False)
            raise
        _record(sql, True)
        return result

    execute_recorded.__nanoclaw_source_tap__ = True
    return execute_recorded


def _wrap_async(execute):
    async def execute_recorded(self, *args, **kwargs):
        if kwargs.get("_describe_only"):
            return await execute(self, *args, **kwargs)
        sql = _command_of(args, kwargs)
        try:
            result = await execute(self, *args, **kwargs)
        except BaseException:
            _record(sql, False)
            raise
        _record(sql, True)
        return result

    execute_recorded.__nanoclaw_source_tap__ = True
    return execute_recorded


def _patch(module):
    try:
        cls = getattr(module, "SnowflakeCursorBase", None)
        execute = getattr(cls, "execute", None) if cls is not None else None
        if execute is None or getattr(execute, "__nanoclaw_source_tap__", False):
            return
        import inspect

        wrapper = _wrap_async(execute) if inspect.iscoroutinefunction(execute) else _wrap_sync(execute)
        cls.execute = wrapper
    except Exception:
        pass


class _Loader:
    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def create_module(self, spec):
        return self._inner.create_module(spec)

    def exec_module(self, module):
        self._inner.exec_module(module)
        _patch(module)


class _Finder:
    def find_spec(self, fullname, path, target=None):
        if fullname not in _TARGETS:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None and spec.loader is not None:
                spec.loader = _Loader(spec.loader)
                return spec
        return None


def install():
    if any(isinstance(f, _Finder) for f in sys.meta_path):
        return
    sys.meta_path.insert(0, _Finder())
    for name in _TARGETS:
        if name in sys.modules:
            _patch(sys.modules[name])


install()
