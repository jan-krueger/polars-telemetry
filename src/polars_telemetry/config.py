"""User-facing configuration."""

from __future__ import annotations

from dataclasses import dataclass

from polars_telemetry.model.redaction import Redaction


@dataclass(frozen=True, slots=True)
class Config:
    """What to record about each query. Every field has a working default."""

    node_metrics: bool = True
    """Read per-node counters once when the query ends.

    polars exposes cumulative counters and no per-node timestamps, so these are
    exact totals with no timing. Disable to emit the query span alone.
    """

    include_plan: bool = False
    """Attach the full plan and its counters to the span as JSON.

    Off by default: it is kilobytes per span and identical for every run of a
    shape. Turn it on when you want the topology, which nothing else carries.
    """

    call_site: bool = True
    """Record the file, line and function that ran the query.

    Costs well under a microsecond. Turn it off to keep source paths out of
    telemetry you do not control.
    """

    describe_fallbacks: bool = True
    """Have polars describe what an in-memory fallback node runs.

    polars leaves such a node unnamed unless asked: this sets
    POLARS_STREAM_ALWAYS_PREPARE_VISUALIZATION_DATA=1 at install() when it is
    unset. The variable is undocumented, costs a fraction of a millisecond per
    query, and polars keeps it on for the process once it has read it.
    """

    insights: bool = True
    """Find what slows each query down, as `polars-telemetry insights` does.

    Runs once the query has finished, after its wall time is measured: a few
    milliseconds even for a plan of a thousand nodes. Findings carry numbers and
    node kinds only.
    """

    progress_interval: float = 1.0
    """Seconds between samples of a running query, for exporters that record
    progress, such as `FileEventExporter`.

    One background thread samples every running query and hands each sample
    to every such exporter. A query that ends before its first sample is never
    announced as running. A sample costs well under a millisecond for a small
    plan and about 15 ms for 500 nodes.
    """

    redaction: Redaction | None = None
    """What to mask before any exporter receives a query; None masks only URL
    query strings, which can hold credentials.

    `Redaction()` masks literal values. One exporter can be given its own with
    `redacted()`. Metrics never carry literals, whatever this says.
    """

    def __post_init__(self) -> None:
        if not self.progress_interval > 0:
            msg = f"progress_interval must be positive, got {self.progress_interval}"
            raise ValueError(msg)
