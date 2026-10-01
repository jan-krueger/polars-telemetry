"""MessagePack payload decoding.

Payload shapes (polars 1.44.x):
  IR plan, physical plan: [{id, input_ids, properties}]
  metrics snapshot:       [{phys_node_key, ...19 counters}]

Physical plan ids and phys_node_key share a namespace; metrics join on it.
"""

from __future__ import annotations

from typing import Any

# Asserted against fixtures by tests/contract. A diff here means polars changed.
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


def decode_plan(payload: bytes) -> list[dict[str, Any]]:
    raise NotImplementedError


def decode_metrics(payload: bytes) -> list[dict[str, Any]]:
    raise NotImplementedError
