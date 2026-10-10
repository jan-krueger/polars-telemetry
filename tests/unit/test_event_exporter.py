"""The events file: what each query did while it ran."""

from __future__ import annotations

import gzip
import json
from typing import Any
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan, enrich
from polars_telemetry.export.events import SCHEMA, FileEventExporter
from polars_telemetry.model.types import COUNTER_NAMES, Progress, Query


def _query() -> Query:
    return enrich(
        Query(
            query_id=uuid4(),
            wall_ms=1500.0,
            plan=build_plan([{"id": 1, "input_ids": [], "properties": {"type": "InMemorySink"}}]),
            metrics=build_metrics(
                [
                    {
                        **dict.fromkeys(COUNTER_NAMES, 0),
                        "phys_node_key": 1,
                        "rows_received": 3,
                        "done": True,
                    }
                ]
            ),
            label="nightly/orders",
        )
    )


def _progress(query: Query, rows: int) -> Progress:
    metrics = build_metrics(
        [
            {
                **dict.fromkeys(COUNTER_NAMES, 0),
                "phys_node_key": 1,
                "rows_received": rows,
                "done": False,
            }
        ]
    )
    return Progress(query.query_id, 1000.0, metrics)


def _events(path) -> list[dict[str, Any]]:
    raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
    return [json.loads(line) for line in raw.decode().splitlines()]


@pytest.mark.parametrize("name", ["events.jsonl", "events.jsonl.gz"])
def test_a_query_is_written_as_its_life(tmp_path, name):
    exporter = FileEventExporter(tmp_path / name)
    query = _query()
    exporter.started(query)
    exporter.progress(_progress(query, 2))
    exporter.export(query)

    events = _events(tmp_path / name)
    assert [e["type"] for e in events] == [
        "process",
        "query.started",
        "query.progress",
        "query.finished",
    ]
    assert {e["schema"] for e in events} == {SCHEMA}
    started, progress, finished = events[1:]
    assert started["profile"]["label"] == "nightly/orders"
    assert started["profile"]["plan"]["physical"][0]["kind"] == "InMemorySink"
    assert progress["nodes"] == {"1": {"rows_received": 2}}
    assert finished["profile"]["schema"] == "polars-telemetry/profile@1"
    assert {started["query_id"], progress["query_id"], finished["query_id"]} == {
        str(query.query_id)
    }


def test_progress_waits_for_a_batch_but_a_start_or_end_is_written_at_once(tmp_path):
    path = tmp_path / "events.jsonl.gz"
    exporter = FileEventExporter(path)
    query = _query()
    exporter.started(query)
    assert len(_events(path)) == 2
    exporter.progress(_progress(query, 2))
    assert len(_events(path)) == 2
    exporter.export(query)
    assert len(_events(path)) == 4


def test_close_writes_what_is_buffered(tmp_path):
    path = tmp_path / "events.jsonl.gz"
    exporter = FileEventExporter(path)
    query = _query()
    exporter.started(query)
    exporter.progress(_progress(query, 2))
    exporter.close()
    assert [e["type"] for e in _events(path)] == ["process", "query.started", "query.progress"]


def test_a_sample_arriving_after_close_is_still_written(tmp_path):
    path = tmp_path / "events.jsonl.gz"
    exporter = FileEventExporter(path)
    query = _query()
    exporter.started(query)
    exporter.close()
    exporter.progress(_progress(query, 2))
    assert _events(path)[-1]["type"] == "query.progress"


def test_each_batch_is_a_gzip_member_so_a_file_reads_up_to_its_last_batch(tmp_path):
    path = tmp_path / "events.jsonl.gz"
    exporter = FileEventExporter(path)
    for _ in range(3):
        exporter.export(_query())
    whole = path.read_bytes()
    members = whole.count(b"\x1f\x8b\x08")
    assert members >= 3
    assert len(_events(path)) == 4
    cut = whole[: whole.rindex(b"\x1f\x8b\x08")]
    assert len(gzip.decompress(cut).decode().splitlines()) == 3


def test_the_process_line_is_written_once(tmp_path):
    path = tmp_path / "events.jsonl"
    exporter = FileEventExporter(path)
    for _ in range(2):
        exporter.export(_query())
    process = [e for e in _events(path) if e["type"] == "process"]
    assert len(process) == 1
    assert {"host", "pid", "polars_telemetry_version"} <= set(process[0])


def test_the_file_rotates_past_max_bytes(tmp_path):
    path = tmp_path / "events.jsonl"
    exporter = FileEventExporter(path, max_bytes=2_000)
    for _ in range(4):
        exporter.export(_query())
    assert (tmp_path / "events.jsonl.1").exists()
    assert path.stat().st_size <= 2_000 + 10_000
    assert _events(path)[0]["type"] == "process"


def test_max_bytes_must_be_positive(tmp_path):
    with pytest.raises(ValueError, match="positive"):
        FileEventExporter(tmp_path / "x.jsonl", max_bytes=0)


def test_every_event_is_numbered_in_a_stream_named_on_its_process_line(tmp_path):
    path = tmp_path / "events.jsonl"
    exporter = FileEventExporter(path, service="orders-etl", environment="prod")
    query = _query()
    exporter.started(query)
    exporter.progress(_progress(query, 2))
    exporter.export(query)
    events = _events(path)
    process = events[0]
    assert (process["service"], process["environment"]) == ("orders-etl", "prod")
    assert len(process["id"]) == 36
    assert [e["seq"] for e in events] == [1, 2, 3, 4]


def test_a_rotated_file_continues_the_same_stream(tmp_path):
    path = tmp_path / "events.jsonl"
    exporter = FileEventExporter(path, max_bytes=2_000)
    for _ in range(4):
        exporter.export(_query())
    before = _events(tmp_path / "events.jsonl.1")
    after = _events(path)
    assert after[0]["id"] == before[0]["id"]
    assert after[0]["seq"] > before[-1]["seq"]
    assert (before[0]["service"], before[0]["environment"]) == (None, None)
