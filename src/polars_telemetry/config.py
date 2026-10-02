"""User-facing configuration."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class SamplingMode(enum.Enum):
    """How often per-node metrics are read during a query."""

    OFF = "off"
    """Query span and plan attributes only; the metrics handle is never read."""

    FINAL = "final"
    """One snapshot at query close. No polling thread."""

    INTERVAL = "interval"
    """Poll on a background thread. Required for per-node windows."""


@dataclass(frozen=True, slots=True)
class Config:
    """Runtime configuration."""

    sampling: SamplingMode = SamplingMode.FINAL
    interval_ms: int = 25
    node_spans: bool = True
    """Emit a child span per physical node. Needs INTERVAL for real windows."""

    redact_literals: bool = False
    """Mask literal values in plan expressions. Does not affect metric
    attributes, which never carry literals (see export.semconv)."""

    resource_attributes: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.interval_ms <= 0:
            msg = f"interval_ms must be positive, got {self.interval_ms}"
            raise ValueError(msg)

    @property
    def effective_interval_ms(self) -> float | None:
        """Sampling resolution, or None when windows cannot be derived."""
        return self.interval_ms if self.sampling is SamplingMode.INTERVAL else None
