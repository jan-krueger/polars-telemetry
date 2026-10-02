"""Signals derived from the counters.

The raw counters say what happened; these say what to do about it. All are
computed from data already collected, so they cost nothing extra to produce.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query

SCAN_KINDS = frozenset({"MultiScan", "Scan"})
JOIN_KINDS = frozenset({"EquiJoin", "Join", "CrossJoin", "SemiAntiJoin", "IEJoin"})


@dataclass(frozen=True, slots=True)
class Diagnostics:
    """Derived signals. Every field is optional: not every plan has every shape."""

    parallel_efficiency: float | None = None
    """cpu / wall / cores. Low means the query is not using the machine."""

    cpu_count: int | None = None

    filter_selectivity: float | None = None
    """Rows surviving the filter. Low is good when the filter runs early."""

    filter_rows_dropped: int | None = None

    join_amplification: float | None = None
    """Rows out over rows in on the probe side. Above 1 means fan-out."""

    projection_efficiency: float | None = None
    """Columns read over columns in the file."""

    morsel_skew: float | None = None
    """Largest morsel over the mean. Above 1 means uneven partitioning."""

    predicate_pushed: bool | None = None
    """True when any scan applies a predicate inside the scan."""

    row_groups_skipped: bool | None = None
    has_table_statistics: bool | None = None

    incomplete_nodes: int = 0
    """Nodes that had not finished when the closing snapshot was taken.

    Non-zero means the counters below are short, so the figures are a floor
    rather than a total.
    """

    @property
    def complete(self) -> bool:
        return self.incomplete_nodes == 0


def derive(query: Query) -> Diagnostics:
    """Compute every diagnostic the plan supports."""
    cores = os.cpu_count()
    parallel = (
        query.cpu_ms / query.wall_ms / cores
        if cores and query.wall_ms > 0 and query.metrics
        else None
    )

    selectivity = dropped = amplification = projection = skew = None
    pushed = skipped = stats = None
    incomplete = 0

    for node_id, node in query.plan.items():
        metric = query.metrics.get(node_id)
        if metric is None:
            continue
        if not metric.done:
            incomplete += 1

        if node.kind == "Filter" and metric.rows_received:
            selectivity = metric.rows_sent / metric.rows_received
            dropped = metric.rows_received - metric.rows_sent

        if node.kind in JOIN_KINDS and node.inputs:
            probe = query.metrics.get(node.inputs[0])
            if probe and probe.rows_sent:
                ratio = metric.rows_sent / probe.rows_sent
                amplification = ratio if amplification is None else max(amplification, ratio)

        if node.kind in SCAN_KINDS:
            props = node.properties
            read = props.get("projected_file_columns") or props.get("projection")
            available = props.get("file_columns")
            if isinstance(read, list) and isinstance(available, list) and available:
                projection = len(read) / len(available)
            # Collapsed across scans with "any" semantics: one pushed-down
            # predicate is worth reporting even if another scan has none.
            pushed = bool(pushed) or props.get("predicate") is not None
            skip = props.get("predicate_file_skip_applied")
            if isinstance(skip, bool):
                skipped = bool(skipped) or skip
            table_stats = props.get("has_table_statistics")
            if isinstance(table_stats, bool):
                stats = bool(stats) or table_stats

        if metric.morsels_received and metric.rows_received:
            mean = metric.rows_received / metric.morsels_received
            if mean:
                ratio = metric.largest_morsel_received / mean
                skew = ratio if skew is None else max(skew, ratio)

    return Diagnostics(
        parallel_efficiency=parallel,
        cpu_count=cores,
        filter_selectivity=selectivity,
        filter_rows_dropped=dropped,
        join_amplification=amplification,
        projection_efficiency=projection,
        morsel_skew=skew,
        predicate_pushed=pushed,
        row_groups_skipped=skipped,
        has_table_statistics=stats,
        incomplete_nodes=incomplete,
    )
