"""Supported polars window and the runtime capability probe."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from polars_telemetry.adapter import module as mod
from polars_telemetry.adapter.decode import (
    decode_metrics,
    decode_plan,
    metrics_problems,
    plan_problems,
)

# The observer hook was added in 1.44.0; 1.44.0's runtime is yanked.
# No upper bound: unknown newer versions are probed, not refused.
SUPPORTED = ">=1.44.1,<1.45"

_log = logging.getLogger("polars_telemetry")


@dataclass(frozen=True, slots=True)
class Capabilities:
    """Result of probing the installed polars."""

    polars_version: str
    has_monitoring_api: bool
    observer_callbacks_ok: bool = False
    plan_payload_ok: bool = False
    metrics_snapshot_ok: bool = False
    problems: tuple[str, ...] = ()

    @property
    def usable(self) -> bool:
        return self.has_monitoring_api and self.observer_callbacks_ok

    @property
    def node_metrics_usable(self) -> bool:
        return self.usable and self.plan_payload_ok and self.metrics_snapshot_ok


@dataclass
class _ProbeResult:
    started: bool = False
    planned: bool = False
    closed: bool = False
    plan_problems: list[str] = field(default_factory=list)
    metric_problems: list[str] = field(default_factory=list)


class _ProbeGuard:
    def __init__(self, handle: Any, result: _ProbeResult) -> None:
        self._handle = handle
        self._result = result

    def close(self) -> None:
        self._result.closed = True
        try:
            records = decode_metrics(self._handle.snapshot_query_metrics())
            self._result.metric_problems = metrics_problems(records)
        except Exception as exc:
            self._result.metric_problems = [f"snapshot failed: {type(exc).__name__}: {exc}"]


class _ProbeObserver:
    def __init__(self, result: _ProbeResult) -> None:
        self._result = result

    def on_query_started(self, query_id: Any) -> None:
        self._result.started = True

    def on_query_planned(
        self, query_id: Any, handle: Any, ir_plan: bytes, physical_plan: bytes
    ) -> _ProbeGuard:
        self._result.planned = True
        try:
            self._result.plan_problems = plan_problems(decode_plan(physical_plan))
        except Exception as exc:
            self._result.plan_problems = [f"plan decode failed: {type(exc).__name__}: {exc}"]
        return _ProbeGuard(handle, self._result)

    def on_query_failed(self, *args: Any) -> None:
        return None


def probe(binding: mod.Binding) -> Capabilities:
    """Run a trivial monitored query and record what the hook delivered.

    Called once from install(), after monitoring is enabled. Degrades instead
    of raising: an unrecognised polars must not break the caller's queries.
    """
    import polars as pl

    version = pl.__version__
    if not hasattr(pl.Config, "enable_monitoring"):
        return Capabilities(
            polars_version=version,
            has_monitoring_api=False,
            problems=("polars.Config.enable_monitoring is missing",),
        )

    result = _ProbeResult()
    previous = getattr(binding.module, mod.FACTORY_ATTR, None)
    mod.set_factory(binding, lambda workspace=None, organization=None: _ProbeObserver(result))
    try:
        pl.DataFrame({"probe": [1, 2, 3]}).lazy().filter(pl.col("probe") > 1).collect()
    except Exception as exc:
        _log.warning("polars-telemetry: probe query failed: %s", exc)
    finally:
        if previous is None:
            delattr(binding.module, mod.FACTORY_ATTR)
        else:
            mod.set_factory(binding, previous)

    problems = [*result.plan_problems, *result.metric_problems]
    if not result.started or not result.planned:
        problems.append("polars did not invoke the observer callbacks")
    if not result.closed:
        problems.append("polars did not close the execution guard")

    return Capabilities(
        polars_version=version,
        has_monitoring_api=True,
        observer_callbacks_ok=result.started and result.planned and result.closed,
        plan_payload_ok=not result.plan_problems,
        metrics_snapshot_ok=not result.metric_problems,
        problems=tuple(problems),
    )
