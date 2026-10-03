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

from typing import TYPE_CHECKING, Any

from polars_telemetry._version import __version__
from polars_telemetry.model.diagnostics import Diagnostics, derive
from polars_telemetry.model.fingerprint import fingerprint
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
    diagnostics = diagnostics if diagnostics is not None else derive(query)
    plan = query.logical or query.plan

    document: dict[str, Any] = {
        "schema": SCHEMA,
        "polars_version": query.polars_version or "unknown",
        "polars_telemetry_version": __version__,
        "query_id": str(query.query_id),
        "fingerprint": fingerprint(plan),
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


def redact_profile(document: dict[str, Any]) -> dict[str, Any]:
    """Mask literal values in a profile document: plan expressions and failure text.

    Every route that hands out a profile -- the file exporter, a scoped
    session -- goes through this, so redaction has one definition.
    """
    from polars_telemetry.export.attributes import redact

    def walk(value: object) -> object:
        if isinstance(value, str):
            return redact(value)
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        return value

    plan = document.get("plan")
    if isinstance(plan, dict):
        document["plan"] = walk(plan)

    # polars' failure text quotes the offending values.
    failed = document.get("failed")
    if isinstance(failed, str):
        document["failed"] = redact(failed)
    return document
