"""User-facing configuration."""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field

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

    redaction: Redaction | None = None
    """What to mask before any exporter receives a query; None masks nothing.

    `Redaction()` masks literal values. One exporter can be given its own with
    `redacted()`. Metrics never carry literals, whatever this says.
    """

    redact_literals: bool = False
    """Deprecated: use `redaction=Redaction()`, which this sets."""

    resource_attributes: dict[str, str] = field(default_factory=dict)
    """Deprecated and never applied: set resource attributes on your
    OpenTelemetry provider instead."""

    def __post_init__(self) -> None:
        if self.redact_literals:
            warnings.warn(
                "Config.redact_literals is deprecated and will be removed in 0.4.0; "
                "use Config(redaction=Redaction()).",
                DeprecationWarning,
                stacklevel=3,
            )
            if self.redaction is None:
                object.__setattr__(self, "redaction", Redaction())
        if self.resource_attributes:
            warnings.warn(
                "Config.resource_attributes has never been applied and will be "
                "removed in 0.4.0; set resource attributes on your OpenTelemetry provider.",
                DeprecationWarning,
                stacklevel=3,
            )
