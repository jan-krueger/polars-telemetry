"""User-facing configuration."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class Config:
    """Runtime configuration."""

    node_metrics: bool = True
    """Read per-node counters once when the query ends.

    polars exposes cumulative counters and no per-node timestamps, so these are
    exact totals with no timing. Disable to emit the query span alone.
    """

    redact_literals: bool = False
    """Mask literal values in plan expressions. Does not affect metric
    attributes, which never carry literals (see export.semconv)."""

    resource_attributes: dict[str, str] = field(default_factory=dict)
