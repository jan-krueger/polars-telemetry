"""Human-readable exporter, for debugging without OTel wiring."""

from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query

_MAX_ROWS = 12


def _ms(value: float) -> str:
    if value >= 10:
        return f"{value:.1f}ms"
    if value >= 0.1:
        return f"{value:.2f}ms"
    return f"{value * 1000:.0f}us"


class ConsoleExporter:
    """Print a short summary of each query: totals, call site, slowest nodes.

    Args:
        stream: Where to write. Defaults to standard error.
    """

    __slots__ = ("_stream",)

    def __init__(self, stream: TextIO | None = None) -> None:
        self._stream = stream if stream is not None else sys.stderr

    def export(self, query: Query) -> None:
        status = f"FAILED {query.failed}" if query.failed else "ok"
        header = (
            f"polars query {query.label or str(query.query_id)[:8]} {status} "
            f"wall={_ms(query.wall_ms)} cpu={_ms(query.cpu_ms)} "
            f"parallelism={query.parallelism:.2f}x nodes={len(query.plan)}"
        )
        if query.result_rows is not None:
            header += f" rows_out={query.result_rows:,}"
        lines = [header]
        if query.call_site is not None:
            site = query.call_site
            lines.append(
                f"  at {os.path.basename(site.filepath)}:{site.lineno} in {site.function}()"
            )

        ranked = sorted(query.metrics.values(), key=lambda node: node.total_time_ns, reverse=True)
        for node in ranked[:_MAX_ROWS]:
            plan_node = query.plan.get(node.node_id)
            kind = plan_node.kind if plan_node else str(node.node_id)
            lines.append(
                f"  {kind:<18} {_ms(node.cpu_ms):>9}"
                f"  in={node.rows_received:>12,}  out={node.rows_sent:>12,}"
            )
        if len(ranked) > _MAX_ROWS:
            lines.append(f"  ... {len(ranked) - _MAX_ROWS} more nodes")

        self._stream.write("\n".join(lines) + "\n")
        self._stream.flush()
