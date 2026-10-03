"""User-facing configuration."""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field


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

    redact_literals: bool = False
    """Mask literal values in plan expressions, such as `"Brand#12"` in a filter.

    Metrics never carry literals, so this affects spans and profiles only.
    """

    resource_attributes: dict[str, str] = field(default_factory=dict)
    """Deprecated and never applied: set resource attributes on your
    OpenTelemetry provider instead."""

    def __post_init__(self) -> None:
        if self.resource_attributes:
            warnings.warn(
                "Config.resource_attributes has never been applied and will be "
                "removed; set resource attributes on your OpenTelemetry provider.",
                DeprecationWarning,
                stacklevel=3,
            )
