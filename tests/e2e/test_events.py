"""Real polars queries recorded while they run."""

from __future__ import annotations

import gzip
import json
import time
from typing import Any

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config  # noqa: E402
from polars_telemetry.export.events import FileEventExporter  # noqa: E402


def _slowly(df: Any) -> Any:
    time.sleep(0.6)
    return df


def _record(tmp_path) -> list[dict[str, Any]]:
    path = tmp_path / "events.jsonl.gz"
    state = polars_telemetry.install(
        Config(progress_interval=0.1, insights=False), exporter=FileEventExporter(path)
    )
    assert state is not None
    try:
        with polars_telemetry.label("slow"):
            polars.LazyFrame({"a": list(range(1000))}).map_batches(_slowly).collect()
        with polars_telemetry.label("fast"):
            polars.LazyFrame({"a": [1, 2, 3]}).select(polars.col("a").sum()).collect()
    finally:
        polars_telemetry.uninstall()
    return [json.loads(line) for line in gzip.decompress(path.read_bytes()).decode().splitlines()]


def test_a_running_query_is_announced_sampled_and_finished_in_order(tmp_path):
    events = _record(tmp_path)
    assert events[0]["type"] == "process"
    slow = [e for e in events if e.get("query_id") and _label(events, e["query_id"]) == "slow"]
    types = [e["type"] for e in slow]
    assert types[0] == "query.started"
    assert types[-1] == "query.finished"
    assert "query.progress" in types
    assert set(types[1:-1]) == {"query.progress"}
    assert slow[0]["plan"]["physical"]
    elapsed = [e["elapsed_ms"] for e in slow if e["type"] == "query.progress"]
    assert elapsed == sorted(elapsed)


def test_a_query_that_ends_before_its_first_sample_is_only_finished(tmp_path):
    events = _record(tmp_path)
    fast = [e for e in events if e.get("query_id") and _label(events, e["query_id"]) == "fast"]
    assert [e["type"] for e in fast] == ["query.finished"]


def test_nothing_is_sampled_without_an_exporter_that_follows_queries(monkeypatch):
    from polars_telemetry.adapter import sampler

    watched: list[Any] = []
    monkeypatch.setattr(sampler.SAMPLER, "watch", lambda *a, **k: watched.append(a))
    collected: list[Any] = []

    class Plain:
        def export(self, query: Any) -> None:
            collected.append(query)

    state = polars_telemetry.install(Config(progress_interval=0.05), exporter=Plain())
    assert state is not None
    try:
        polars.LazyFrame({"a": [1]}).map_batches(_slowly).collect()
    finally:
        polars_telemetry.uninstall()
    assert (watched, len(collected)) == ([], 1)


def _label(events: list[dict[str, Any]], query_id: str) -> str | None:
    for event in events:
        if event.get("query_id") == query_id and event["type"] == "query.finished":
            return event["profile"]["label"]
    return None
