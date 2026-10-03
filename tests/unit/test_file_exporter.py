"""Writing profiles to a session file."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.export.file import FileExporter
from polars_telemetry.model.types import Query

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


def _query() -> Query:
    return Query(
        query_id=uuid4(),
        wall_ms=12.0,
        plan=build_plan(json.loads((FIXTURE / "physical.json").read_text())),
        logical=build_plan(json.loads((FIXTURE / "ir.json").read_text())),
        metrics=build_metrics(json.loads((FIXTURE / "metrics.json").read_text())),
    )


def test_writes_one_json_line_per_query(tmp_path):
    exporter = FileExporter(tmp_path / "session.jsonl")
    for _ in range(3):
        exporter.export(_query())

    lines = exporter.path.read_text().strip().splitlines()
    assert len(lines) == 3
    assert all(json.loads(line)["schema"] for line in lines)


def test_each_line_stands_alone(tmp_path):
    """A truncated file must still parse up to the cut."""
    exporter = FileExporter(tmp_path / "s.jsonl")
    exporter.export(_query())
    exporter.export(_query())

    text = exporter.path.read_text()
    first = text.splitlines()[0]
    assert json.loads(first)["query_id"]


def test_creates_missing_parent_directories(tmp_path):
    exporter = FileExporter(tmp_path / "deep" / "nested" / "s.jsonl")
    exporter.export(_query())
    assert exporter.path.exists()


def test_rotates_at_the_size_bound(tmp_path):
    exporter = FileExporter(tmp_path / "s.jsonl", max_bytes=64 * 1024)
    for _ in range(40):
        exporter.export(_query())

    assert exporter.path.exists()
    assert (tmp_path / "s.jsonl.1").exists(), "previous generation should be kept"
    assert exporter.path.stat().st_size <= 64 * 1024 * 2


def test_a_record_larger_than_the_bound_is_still_written(tmp_path):
    """Never split or drop a profile; the bound holds between records."""
    exporter = FileExporter(tmp_path / "s.jsonl", max_bytes=1)
    exporter.export(_query())
    exporter.export(_query())

    assert len(exporter.path.read_text().strip().splitlines()) == 1
    assert (tmp_path / "s.jsonl.1").exists()
    assert exporter.errors == 0


def test_rejects_a_nonsense_bound(tmp_path):
    with pytest.raises(ValueError, match="max_bytes"):
        FileExporter(tmp_path / "s.jsonl", max_bytes=0)


def test_redaction_masks_plan_literals(tmp_path):
    plain = FileExporter(tmp_path / "plain.jsonl")
    masked = FileExporter(tmp_path / "masked.jsonl", redact_literals=True)
    query = _query()
    plain.export(query)
    masked.export(query)

    assert "10.0" in plain.path.read_text()
    assert "<num>" in masked.path.read_text()


def test_a_write_failure_does_not_raise(tmp_path, monkeypatch):
    exporter = FileExporter(tmp_path / "s.jsonl")
    query = _query()  # built before patching: the fixture load also uses Path.open

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "open", boom)
    exporter.export(query)  # must not raise
    assert exporter.errors == 1


def test_concurrent_writes_do_not_interleave(tmp_path):
    import threading

    exporter = FileExporter(tmp_path / "s.jsonl")
    threads = [threading.Thread(target=lambda: exporter.export(_query())) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = exporter.path.read_text().strip().splitlines()
    assert len(lines) == 8
    for line in lines:
        json.loads(line)


def test_redaction_reaches_the_failure_message(tmp_path):
    """polars quotes the offending value in the text, not just in the plan."""
    from polars_telemetry.export.profile import redact_profile

    document: dict[str, object] = {
        "failed": "conversion failed in column 'a' for 1 out of 1 values: [\"secret\"]",
        "plan": {"physical": []},
    }
    assert "secret" not in str(redact_profile(document)["failed"])
