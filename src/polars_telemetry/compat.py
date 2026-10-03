"""Supported polars window and the runtime capability probe."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from polars_telemetry.adapter import module as mod
from polars_telemetry.adapter.decode import (
    decode_metrics,
    decode_plan,
    metrics_breaks,
    metrics_problems,
    plan_problems,
)
from polars_telemetry.adapter.hook import ObserverFactory

# The tested window, quoted in messages. Versions outside it are probed, not refused.
SUPPORTED = ">=1.44.1,<1.45"

_log = logging.getLogger("polars_telemetry")


@dataclass(frozen=True, slots=True)
class Capabilities:
    """Result of probing the installed polars."""

    polars_version: str
    has_monitoring_api: bool
    observer_callbacks_ok: bool = False
    plan_payload_ok: bool = False
    ir_payload_ok: bool = False
    """The IR carries the user's own column names; without it, span
    attributes fall back to the physical plan's _POLARS_TMP_N names."""
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
    ir_problems: list[str] = field(default_factory=list)
    metric_problems: list[str] = field(default_factory=list)
    metric_breaks: list[str] = field(default_factory=list)


class _ProbeRecorder:
    """Captures what polars delivered, through the same hook real queries use,
    so the callback protocol is written once."""

    def __init__(self, result: _ProbeResult) -> None:
        self._result = result
        self._handle: Any = None

    def started(self, query_id: Any) -> None:
        self._result.started = True

    def planned(self, query_id: Any, ir_plan: bytes, physical_plan: bytes, handle: Any) -> None:
        self._result.planned = True
        self._handle = handle
        try:
            self._result.plan_problems = plan_problems(decode_plan(physical_plan))
        except Exception as exc:
            self._result.plan_problems = [f"plan decode failed: {type(exc).__name__}: {exc}"]
        try:
            self._result.ir_problems = [f"IR: {p}" for p in plan_problems(decode_plan(ir_plan))]
        except Exception as exc:
            self._result.ir_problems = [f"IR decode failed: {type(exc).__name__}: {exc}"]

    def failed(self, message: str) -> None:
        return

    def closed(self) -> None:
        self._result.closed = True
        try:
            records = decode_metrics(self._handle.snapshot_query_metrics())
            self._result.metric_problems = metrics_problems(records)
            self._result.metric_breaks = metrics_breaks(records)
        except Exception as exc:
            failure = [f"snapshot failed: {type(exc).__name__}: {exc}"]
            self._result.metric_problems = failure
            self._result.metric_breaks = failure


def probe(binding: mod.Binding) -> Capabilities:
    """Run a trivial monitored query and record what the hook delivered.

    Called once from install(), after monitoring is enabled. Degrades instead
    of raising: an unrecognised polars must not break the caller's queries.
    """
    import polars as pl

    version = pl.__version__
    result = _ProbeResult()
    previous = getattr(binding.module, mod.FACTORY_ATTR, None)
    mod.set_factory(binding, ObserverFactory(lambda _: _ProbeRecorder(result), label="probe"))
    try:
        pl.DataFrame({"probe": [1, 2, 3]}).lazy().filter(pl.col("probe") > 1).collect()
    except Exception as exc:
        _log.warning("polars-telemetry: probe query failed: %s", exc)
    finally:
        if previous is None:
            delattr(binding.module, mod.FACTORY_ATTR)
        else:
            mod.set_factory(binding, previous)

    problems = [*result.plan_problems, *result.ir_problems, *result.metric_problems]
    if not result.started or not result.planned:
        problems.append("polars did not invoke the observer callbacks")
    if not result.closed:
        problems.append("polars did not close the execution guard")

    return Capabilities(
        polars_version=version,
        has_monitoring_api=True,
        observer_callbacks_ok=result.started and result.planned and result.closed,
        plan_payload_ok=not result.plan_problems,
        ir_payload_ok=not result.ir_problems,
        metrics_snapshot_ok=not result.metric_breaks,
        problems=tuple(problems),
    )
