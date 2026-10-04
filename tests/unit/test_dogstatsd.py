"""DogStatsD: the same metrics as OpenTelemetry, named and tagged as asked."""

from __future__ import annotations

import dataclasses
import socket
from typing import Any
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_plan, enrich
from polars_telemetry.export.dogstatsd import DogStatsdExporter
from polars_telemetry.export.measurements import COUNTERS, HISTOGRAMS
from polars_telemetry.model.insights import Finding
from polars_telemetry.model.insights.finding import Impact
from polars_telemetry.model.types import NodeMetrics, Query

datadog = pytest.importorskip("datadog")


_FINDING = Finding(
    rule="in_memory_fallback",
    kind="problem",
    level="warn",
    node_id=0,
    node_kind="GroupBy",
    impact=Impact(cpu_share=1.0, blocked_share=0.5),
    title="t",
    detail="d",
    evidence={},
)


def _busy_query(label: str | None = None) -> Query:
    """One node with every counter non-zero, so no metric is skipped as empty."""
    fields: dict[str, Any] = {f.name: 7 for f in dataclasses.fields(NodeMetrics)}
    fields.update(node_id=0, done=True, total_polls=10, total_stolen_polls=3)
    return enrich(
        Query(
            query_id=uuid4(),
            wall_ms=12.0,
            plan=build_plan([{"id": 0, "input_ids": [], "properties": {"type": "GroupBy"}}]),
            metrics={0: NodeMetrics(**fields)},
            insights=(_FINDING,),
            label=label,
            engine="streaming",
        )
    )


class Recorder:
    """Stands in for datadog.DogStatsd, keeping every call."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, float, list[str]]] = []
        self.flushed = 0

    def distribution(self, name: str, value: float, tags: list[str]) -> None:
        self.sent.append(("d", name, value, tags))

    def histogram(self, name: str, value: float, tags: list[str]) -> None:
        self.sent.append(("h", name, value, tags))

    def increment(self, name: str, value: float, tags: list[str]) -> None:
        self.sent.append(("c", name, value, tags))

    def flush(self) -> None:
        self.flushed += 1


def _send(**options: Any) -> Recorder:
    client = Recorder()
    DogStatsdExporter(client, **options).export(_busy_query(label="nightly/report"))
    return client


def test_every_metric_is_sent_with_its_kind():
    sent = {(kind, name) for kind, name, _, _ in _send().sent}
    assert sent == {("d", name) for name, _, _ in HISTOGRAMS} | {
        ("c", name) for name, _, _ in COUNTERS
    }


def test_times_can_go_as_histograms_for_telegraf():
    kinds = {(kind, name) for kind, name, _, _ in _send(distributions=False).sent}
    assert ("h", "polars.query.duration") in kinds
    assert not any(kind == "d" for kind, _ in kinds)


def test_tags_are_short_and_bounded():
    client = _send()
    duration = next(tags for _, name, _, tags in client.sent if name == "polars.query.duration")
    rows = next(tags for _, name, _, tags in client.sent if name == "polars.node.rows_out")
    assert sorted(duration) == ["engine:streaming", f"fingerprint:{_busy_query().fingerprint}"]
    assert sorted(rows) == ["engine:streaming", "node_kind:GroupBy"]
    assert not any(tag.startswith("label:") for _, _, _, tags in client.sent for tag in tags)


def test_metrics_can_be_renamed_or_left_out():
    client = _send(
        metric_names={"polars.query.duration": "polars_query_ms", "polars.node.polls": None}
    )
    names = {name for _, name, _, _ in client.sent}
    assert "polars_query_ms" in names
    assert "polars.query.duration" not in names
    assert "polars.node.polls" not in names


def test_metrics_can_be_renamed_by_a_rule():
    names = {name for _, name, _, _ in _send(metric_names=lambda n: n.replace(".", "_")).sent}
    assert "polars_node_rows_out" in names


def test_tag_keys_can_be_renamed_or_left_out():
    client = _send(tag_names={"node_kind": "kind", "fingerprint": None})
    tags = {tag.split(":")[0] for _, _, _, tags in client.sent for tag in tags}
    assert tags == {"engine", "kind", "direction", "rule", "level"}


def test_labels_become_a_tag_only_when_asked():
    client = _send(tag_labels=True)
    assert all("label:nightly/report" in tags for _, _, _, tags in client.sent)


def test_close_flushes_the_client():
    client = Recorder()
    DogStatsdExporter(client).close()
    assert client.flushed == 1


def test_close_never_waits_forever_on_the_sender():
    """close() runs at exit, where a stopped sender must not hang the process."""
    waited: list[float | None] = []

    class Background(Recorder):
        def wait_for_pending(self, timeout: float | None = None) -> None:
            waited.append(timeout)

    DogStatsdExporter(Background()).close()
    assert waited
    assert waited[0] is not None


@pytest.mark.parametrize(
    "options",
    [{"tag_names": {"nodekind": "kind"}}, {"metric_names": {"polars.query.durration": "x"}}],
)
def test_a_misspelt_name_is_an_error_not_a_no_op(options):
    with pytest.raises(ValueError, match="unknown"):
        DogStatsdExporter(Recorder(), **options)


def test_the_real_client_sends_dogstatsd_lines():
    """Through Datadog's own client and a socket, as the Agent or Telegraf sees it."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.settimeout(2)
        client = datadog.DogStatsd(
            host="127.0.0.1",
            port=listener.getsockname()[1],
            disable_buffering=False,
            disable_telemetry=True,
            origin_detection_enabled=False,
        )
        exporter = DogStatsdExporter(client)
        exporter.export(_busy_query())
        exporter.close()

        lines: list[str] = []
        while not any(line.startswith("polars.node.io_bytes") for line in lines):
            lines += listener.recv(65535).decode().splitlines()

    duration = next(line for line in lines if line.startswith("polars.query.duration:"))
    assert duration.startswith("polars.query.duration:12.0|d|#")
    assert "engine:streaming" in duration
    assert any(line.startswith("polars.node.rows_out:7|c|#") for line in lines)


def test_counters_are_summed_per_node_kind_and_histograms_are_not():
    """A counter only adds, so summing first is invisible to any backend."""
    fields: dict[str, Any] = {f.name: 0 for f in dataclasses.fields(NodeMetrics)}
    plan = build_plan(
        [
            {"id": 0, "input_ids": [], "properties": {"type": "GroupBy"}},
            {"id": 1, "input_ids": [0], "properties": {"type": "GroupBy"}},
            {"id": 2, "input_ids": [1], "properties": {"type": "Filter"}},
        ]
    )
    metrics = {
        i: NodeMetrics(**{**fields, "node_id": i, "rows_sent": rows, "total_time_ns": 1_000_000})
        for i, rows in ((0, 10), (1, 5), (2, 7))
    }
    query = enrich(
        Query(query_id=uuid4(), wall_ms=1.0, plan=plan, metrics=metrics, engine="streaming")
    )
    client = Recorder()
    DogStatsdExporter(client).export(query)

    rows = {
        tuple(sorted(tags)): value
        for _, name, value, tags in client.sent
        if name == "polars.node.rows_out"
    }
    assert rows == {
        ("engine:streaming", "node_kind:GroupBy"): 15,
        ("engine:streaming", "node_kind:Filter"): 7,
    }
    cpu = [value for _, name, value, _ in client.sent if name == "polars.node.cpu_time"]
    assert len(cpu) == 3, "one histogram value per node, never merged"
