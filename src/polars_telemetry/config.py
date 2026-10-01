"""User-facing configuration."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class SamplingMode(enum.Enum):
    """How often per-node metrics are read during a query."""

    OFF = "off"
    """Query span and plan attributes only. No metrics handle polling."""

    FINAL = "final"
    """One snapshot when the query closes. The default: no polling thread."""

    INTERVAL = "interval"
    """Poll on a background thread. Required for per-node timelines."""


@dataclass(frozen=True, slots=True)
class Config:
    """Runtime configuration for the instrumentation."""

    sampling: SamplingMode = SamplingMode.FINAL
    interval_ms: int = 25
    """Polling period for :attr:`SamplingMode.INTERVAL`."""

    node_spans: bool = True
    """Emit a child span per physical node. Requires ``INTERVAL`` for windows."""

    redact_literals: bool = False
    """Replace literal values in plan expressions with type placeholders.

    Off by default: knowing *which* predicate was slow is usually the whole
    point. Turn it on when exporting to a telemetry backend you do not control.
    Note that plan literals are never used as metric attributes regardless of
    this setting -- unbounded values are a cardinality hazard.
    """

    resource_attributes: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        raise NotImplementedError
