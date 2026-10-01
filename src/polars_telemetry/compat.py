"""Supported polars window and the runtime capability probe."""

from __future__ import annotations

from dataclasses import dataclass

# The observer hook was added in 1.44.0; 1.44.0's runtime is yanked.
# No upper bound: unknown newer versions are probed, not refused.
SUPPORTED = ">=1.44.1,<1.45"


@dataclass(frozen=True, slots=True)
class Capabilities:
    """Result of probing the installed polars."""

    polars_version: str
    has_monitoring_api: bool
    observer_callbacks_ok: bool
    plan_payload_ok: bool
    metrics_snapshot_ok: bool

    @property
    def usable(self) -> bool:
        raise NotImplementedError

    @property
    def node_metrics_usable(self) -> bool:
        raise NotImplementedError


def probe() -> Capabilities:
    """Run a trivial monitored query and record what the hook delivered.

    Called once from install(). Degrades instead of raising: an unrecognised
    polars must not break the caller's queries.
    """
    raise NotImplementedError
