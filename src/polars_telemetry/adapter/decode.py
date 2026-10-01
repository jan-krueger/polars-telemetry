"""MessagePack payloads -> plain dicts.

Three payload shapes, all from polars 1.44.x:

- IR plan: ``[{id, input_ids, properties}]`` with logical node types.
- Physical plan: same shape, physical node types, ids matching metrics.
- Metrics snapshot: ``[{phys_node_key, ...19 counters}]``.

Field names are asserted against checked-in fixtures, not trusted.
"""

from __future__ import annotations

from typing import Any

METRIC_FIELDS: frozenset[str] = frozenset(
    {
        "phys_node_key",
        "total_polls",
        "total_stolen_polls",
        "total_poll_time_ns",
        "max_poll_time_ns",
        "total_state_updates",
        "total_state_update_time_ns",
        "max_state_update_time_ns",
        "morsels_sent",
        "rows_sent",
        "largest_morsel_sent",
        "morsels_received",
        "rows_received",
        "largest_morsel_received",
        "io_total_active_ns",
        "io_total_bytes_requested",
        "io_total_bytes_received",
        "io_total_bytes_sent",
        "total_time_ns",
        "done",
    }
)
"""The 20 fields observed on 1.44.1 and 1.44.2. Contract tests assert this set."""


def decode_plan(payload: bytes) -> list[dict[str, Any]]:
    raise NotImplementedError


def decode_metrics(payload: bytes) -> list[dict[str, Any]]:
    raise NotImplementedError
