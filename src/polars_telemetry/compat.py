"""The supported polars window, and the probe that verifies it.

The observer hook does not exist before polars 1.44.0, and 1.44.0's runtime is
yanked, so the floor is 1.44.1. There is no upper pin: an unknown newer polars
is probed rather than refused.
"""

from __future__ import annotations

from dataclasses import dataclass

SUPPORTED = ">=1.44.1,<1.45"
"""Versions whose contract is covered by checked-in fixtures and CI."""


@dataclass(frozen=True, slots=True)
class Capabilities:
    """What the installed polars actually supports, as measured."""

    polars_version: str
    has_monitoring_api: bool
    observer_callbacks_ok: bool
    plan_payload_ok: bool
    metrics_snapshot_ok: bool

    @property
    def usable(self) -> bool:
        """Whether any instrumentation at all can be installed."""
        raise NotImplementedError

    @property
    def node_metrics_usable(self) -> bool:
        """Whether per-node spans and metrics can be produced."""
        raise NotImplementedError


def probe() -> Capabilities:
    """Run a trivial monitored query and observe what the hook delivers.

    Costs milliseconds and runs once at :func:`~polars_telemetry.install`. On
    anything unexpected we degrade rather than raise: the caller's queries must
    keep working on a polars we have never seen.
    """
    raise NotImplementedError
