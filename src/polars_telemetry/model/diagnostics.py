"""Signals derived from the counters.

The raw counters say what happened; these say what to do about it. All are
computed from data already collected, so they cost nothing extra to produce.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from polars_telemetry.model.types import JOIN_ROLES, NodeRole

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query


@dataclass(frozen=True, slots=True)
class Diagnostics:
    """Derived signals. Every field is optional: not every plan has every shape."""

    parallel_efficiency: float | None = None
    """cpu / wall / cores. Low means the query is not using the machine."""

    cpu_count: int | None = None
    """Threads in polars' pool: honours CPU affinity, a cgroup CPU quota and
    POLARS_MAX_THREADS."""

    filter_selectivity: float | None = None
    """Deprecated, removed in 0.7.0: the share of rows one filter kept, and with
    several filters whichever the plan lists last."""

    filter_rows_dropped: int | None = None
    """Deprecated, removed in 0.7.0, with `filter_selectivity`."""

    join_growth: float | None = None
    """The largest join's rows out over its larger input. Above 2 needs
    many-to-many keys: a one-to-many join stays within both inputs together."""

    projection_efficiency: float | None = None
    """Columns read over columns in the file."""

    morsel_skew: float | None = None
    """The largest of any node's largest morsel over its mean. Above 1 means
    uneven partitioning somewhere in the plan."""

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


def derive(query: Query, threads: int | None = None) -> Diagnostics:
    """Compute every diagnostic the plan supports.

    `threads` is the size of polars' pool, which the adapter reads; without it
    the machine's core count stands in, which overstates a container's share.
    """
    cores = threads or os.cpu_count()
    parallel = (
        query.cpu_ms / query.wall_ms / cores
        if cores and query.wall_ms > 0 and query.metrics
        else None
    )

    selectivity = dropped = growth = projection = skew = None
    columns_read = 0
    pushed = skipped = stats = None
    incomplete = 0

    consumers: dict[int, int] = {}
    for node in query.plan.values():
        for input_id in node.inputs:
            consumers[input_id] = consumers.get(input_id, 0) + 1

    for node_id, node in query.plan.items():
        metric = query.metrics.get(node_id)
        if metric is None:
            continue
        if not metric.done:
            incomplete += 1

        if node.role is NodeRole.SELECTION and metric.rows_received:
            selectivity = metric.rows_sent / metric.rows_received
            dropped = metric.rows_received - metric.rows_sent

        if node.role in JOIN_ROLES and node.inputs:
            larger = max(
                (
                    received.rows_sent / consumers.get(input_id, 1)
                    for input_id in node.inputs
                    if (received := query.metrics.get(input_id)) is not None
                ),
                default=0,
            )
            if larger:
                ratio = metric.rows_sent / larger
                growth = ratio if growth is None else max(growth, ratio)

        if metric.morsels_received and metric.rows_received:
            mean = metric.rows_received / metric.morsels_received
            if mean:
                ratio = metric.largest_morsel_received / mean
                skew = ratio if skew is None else max(skew, ratio)

    # Read from the plan alone, so these survive Config(node_metrics=False) and
    # any scan whose counters are missing. Collapsed across scans with "any"
    # semantics: one pushed-down predicate is worth reporting even if another
    # scan has none.
    for node in query.plan.values():
        scan = node.scan
        if scan is None:
            continue
        if scan.columns_read is not None:
            columns_read += scan.columns_read
        pushed = bool(pushed) or scan.predicate_pushed
        if scan.row_groups_skipped is not None:
            skipped = bool(skipped) or scan.row_groups_skipped
        if scan.has_statistics is not None:
            stats = bool(stats) or scan.has_statistics

    # The two halves of the ratio live on different plans: the physical scan
    # reports what was read, the IR scan what the file holds.
    columns_available = sum(
        node.scan.file_columns
        for node in query.logical.values()
        if node.scan is not None and node.scan.file_columns is not None
    )
    if columns_available and columns_read:
        projection = columns_read / columns_available

    return Diagnostics(
        parallel_efficiency=parallel,
        cpu_count=cores,
        filter_selectivity=selectivity,
        filter_rows_dropped=dropped,
        join_growth=growth,
        projection_efficiency=projection,
        morsel_skew=skew,
        predicate_pushed=pushed,
        row_groups_skipped=skipped,
        has_table_statistics=stats,
        incomplete_nodes=incomplete,
    )
