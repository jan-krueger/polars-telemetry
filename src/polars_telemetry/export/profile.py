"""The profile document: one self-contained record per query.

This is the contract between the package and any viewer. It is deliberately
plain JSON with no references to anything outside itself, so a profile can be
attached to a bug report, committed next to a regression test, or opened in a
page that does no network I/O at all.

Versioning carries two numbers because there are two sources of change: this
schema, and polars' own counter set. A file written today must still open when
polars has added a twentieth counter.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from polars_telemetry._version import __version__
from polars_telemetry.model.diagnostics import Diagnostics, derive
from polars_telemetry.model.types import COUNTER_NAMES

if TYPE_CHECKING:
    from polars_telemetry.model.types import NodeMetrics, PlanNode, Query

SCHEMA = "polars-telemetry/profile@1"


def _trace_context() -> dict[str, str]:
    """Link the profile to the span for the same query, when one is active."""
    try:
        from opentelemetry import trace

        context = trace.get_current_span().get_span_context()
        if not context.is_valid:
            return {}
        return {
            "trace_id": format(context.trace_id, "032x"),
            "span_id": format(context.span_id, "016x"),
        }
    except Exception:
        return {}


def _metrics(metric: NodeMetrics | None) -> dict[str, Any] | None:
    if metric is None:
        return None
    return {**{name: getattr(metric, name) for name in COUNTER_NAMES}, "done": metric.done}


def _node(node: PlanNode, metric: NodeMetrics | None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": node.node_id,
        "kind": node.kind,
        # The stable vocabulary, so a reader need not learn polars' kind names.
        # Additive, so profile@1 readers that predate it are unaffected.
        "role": node.role.value,
        "inputs": list(node.inputs),
        "properties": node.properties,
    }
    counters = _metrics(metric)
    if counters is not None:
        entry["metrics"] = counters
    return entry


def build_profile(query: Query, *, diagnostics: Diagnostics | None = None) -> dict[str, Any]:
    """Assemble the complete profile document for one query."""
    diagnostics = diagnostics or query.diagnostics or derive(query)

    document: dict[str, Any] = {
        "schema": SCHEMA,
        "polars_version": query.polars_version or "unknown",
        "polars_telemetry_version": __version__,
        "query_id": str(query.query_id),
        "label": query.label,
        "fingerprint": query.fingerprint,
        "started_unix_ns": query.started_unix_ns,
        "wall_ms": round(query.wall_ms, 4),
        "cpu_ms": round(query.cpu_ms, 4),
        "result_rows": query.result_rows,
        "call_site": (
            None
            if query.call_site is None
            else {
                "filepath": query.call_site.filepath,
                "lineno": query.call_site.lineno,
                "function": query.call_site.function,
            }
        ),
        "failed": query.failed,
        "redacted": list(query.redaction.masks) if query.redaction is not None else None,
        "diagnostics": {
            field: getattr(diagnostics, field)
            for field in Diagnostics.__dataclass_fields__
            if getattr(diagnostics, field) is not None
        },
        "plan": {
            "physical": [
                _node(node, query.metrics.get(node_id)) for node_id, node in query.plan.items()
            ],
            "logical": [_node(node, None) for node in query.logical.values()],
        },
    }
    document.update(_trace_context())
    return document


def profile_line(document: dict[str, Any]) -> str:
    """One line of a session file. Values JSON has no form for become text."""
    return json.dumps(document, separators=(",", ":"), default=str)
