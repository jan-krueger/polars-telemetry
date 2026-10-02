"""Instrumentation overhead budget.

Measured by interleaving instrumented and uninstrumented runs so machine drift
cancels. A non-interleaved loop is not good enough: it was what made an earlier
measurement read 2-5% when the real figure was inside the noise.

Both arms force the streaming engine. Enabling monitoring changes polars'
engine affinity, so a default-engine baseline would be comparing engines rather
than instrumentation.
"""

from __future__ import annotations

import statistics
import time

import pytest

pytestmark = [pytest.mark.bench]

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config  # noqa: E402

# Generous enough to survive a noisy CI runner, tight enough to catch a
# polling-class regression, which measured 5-15%.
BUDGET = 0.10
ROWS = 2_000_000
REPS = 9


class _Null:
    def export(self, query: object) -> None:
        return None


@pytest.fixture(scope="module")
def frames():
    pl = polars
    orders = pl.DataFrame(
        {
            "cid": [i % 1000 for i in range(ROWS)],
            "amount": [float(i % 97) for i in range(ROWS)],
            "qty": [(i % 5) + 1 for i in range(ROWS)],
        }
    )
    customers = pl.DataFrame({"cid": list(range(1000)), "seg": ["a", "b", "c", "d"] * 250})
    return orders, customers


def _run(frames) -> None:
    pl = polars
    orders, customers = frames
    (
        orders.lazy()
        .filter(pl.col("amount") > 20)
        .join(customers.lazy(), on="cid", how="inner")
        .with_columns((pl.col("amount") * pl.col("qty")).alias("rev"))
        .group_by("seg")
        .agg(pl.col("rev").sum())
        .sort("seg")
        .collect(engine="streaming")
    )


def _time(frames) -> float:
    start = time.perf_counter()
    _run(frames)
    return (time.perf_counter() - start) * 1000


def test_overhead_is_within_budget(frames):
    for _ in range(2):
        _run(frames)

    baseline: list[float] = []
    instrumented: list[float] = []
    for _ in range(REPS):
        baseline.append(_time(frames))
        polars_telemetry.install(Config(), exporter=_Null())
        try:
            instrumented.append(_time(frames))
        finally:
            polars_telemetry.uninstall()

    base = statistics.median(baseline)
    with_telemetry = statistics.median(instrumented)
    overhead = with_telemetry / base - 1

    assert overhead < BUDGET, (
        f"instrumentation overhead {overhead:.1%} exceeds the {BUDGET:.0%} budget "
        f"(baseline {base:.1f}ms, instrumented {with_telemetry:.1f}ms). "
        "Something started doing per-query work that is not a single snapshot."
    )


def test_a_single_snapshot_is_taken_per_query(frames, monkeypatch):
    """The settle loop must not become an unconditional retry."""
    from polars_telemetry.adapter.handle import MetricsHandle

    calls = {"n": 0}
    original = MetricsHandle.snapshot

    def counting(self):
        calls["n"] += 1
        return original(self)

    monkeypatch.setattr(MetricsHandle, "snapshot", counting)

    polars_telemetry.install(Config(), exporter=_Null())
    try:
        _run(frames)
    finally:
        polars_telemetry.uninstall()

    # One query, so one settled snapshot; the retry only fires if the engine
    # has not finished flushing.
    assert calls["n"] <= 2, f"took {calls['n']} snapshots for one query"
