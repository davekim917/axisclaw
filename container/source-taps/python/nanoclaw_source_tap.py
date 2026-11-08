"""Loads the Snowflake source tap only in a container whose group turned the sources footer on.

Every Python process imports this at startup, so it does nothing but one stat when the footer is off.
"""

import os

_LEDGER = os.environ.get("NANOCLAW_SOURCE_LEDGER") or "/tmp/nanoclaw-sources/ledger.jsonl"

if os.path.exists(os.path.join(os.path.dirname(_LEDGER), "enabled")):
    try:
        import nanoclaw_source_tap_impl  # noqa: F401
    except Exception:
        pass
