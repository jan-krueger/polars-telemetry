"""The events@1 and profile@1 JSON Schemas, against what the exporters write."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from polars_telemetry.export.events import FileEventExporter
from polars_telemetry.export.file import FileExporter
from tests.unit.test_event_exporter import _events, _progress, _query

SCHEMAS = Path(__file__).resolve().parents[2] / "docs" / "schemas"
EXAMPLES = sorted((SCHEMAS / "examples").glob("*.jsonl"))


def _load(path: Path) -> dict[str, Any]:
    document: dict[str, Any] = json.loads(path.read_text())
    return document


def _validator(name: str) -> Draft202012Validator:
    registry: Registry[Any] = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema))
        for schema in map(_load, SCHEMAS.glob("*.schema.json"))
    )
    return Draft202012Validator(_load(SCHEMAS / name), registry=registry)


EVENT = _validator("events-v1.schema.json")
PROFILE = _validator("profile-v1.schema.json")


def _problems(validator: Draft202012Validator, document: Any) -> list[str]:
    return [f"{list(e.absolute_path)}: {e.message}" for e in validator.iter_errors(document)]


@pytest.mark.parametrize("name", ["events-v1.schema.json", "profile-v1.schema.json"])
def test_the_schemas_are_valid_json_schema(name):
    Draft202012Validator.check_schema(_load(SCHEMAS / name))


@pytest.mark.parametrize("example", EXAMPLES, ids=lambda path: path.name)
def test_every_example_recording_is_valid(example):
    lines = [json.loads(line) for line in example.read_text().splitlines()]
    assert lines[0]["type"] == "process"
    assert [problem for line in lines for problem in _problems(EVENT, line)] == []


def test_what_the_events_exporter_writes_is_valid(tmp_path):
    path = tmp_path / "events.jsonl"
    exporter = FileEventExporter(path, service="orders-etl")
    query = _query()
    exporter.started(query)
    exporter.progress(_progress(query, 2))
    exporter.export(query)
    events = _events(path)
    assert [e["type"] for e in events] == [
        "process",
        "query.started",
        "query.progress",
        "query.finished",
    ]
    assert [problem for event in events for problem in _problems(EVENT, event)] == []


def test_what_the_jsonl_exporter_writes_is_a_valid_profile(tmp_path):
    path = tmp_path / "profiles.jsonl"
    FileExporter(path).export(_query())
    assert _problems(PROFILE, json.loads(path.read_text())) == []


def test_a_reader_meets_new_fields_and_event_types_without_complaint():
    assert (
        _problems(EVENT, {"schema": "polars-telemetry/events@1", "seq": 9, "type": "query.paused"})
        == []
    )
    progress = {
        "schema": "polars-telemetry/events@1",
        "seq": 3,
        "type": "query.progress",
        "query_id": "01a12532-7bcd-7082-8a3f-bd94907497ea",
        "elapsed_ms": 500.0,
        "nodes": {"1": {"rows_sent": 10, "a_counter_polars_added": 4}},
        "a_field_added_later": True,
    }
    assert _problems(EVENT, progress) == []


@pytest.mark.parametrize(
    ("event", "why"),
    [
        ({"schema": "polars-telemetry/events@1", "type": "process"}, "seq"),
        ({"schema": "polars-telemetry/events@2", "seq": 1, "type": "process"}, "schema"),
        (
            {
                "schema": "polars-telemetry/events@1",
                "seq": 2,
                "type": "query.started",
                "query_id": "x",
            },
            "profile",
        ),
        (
            {
                "schema": "polars-telemetry/events@1",
                "seq": 3,
                "type": "query.progress",
                "query_id": "01a12532-7bcd-7082-8a3f-bd94907497ea",
                "elapsed_ms": 1.0,
                "nodes": {"1": {"rows_sent": -5}},
            },
            "-5",
        ),
    ],
)
def test_a_broken_event_is_rejected_with_the_reason(event, why):
    problems = _problems(EVENT, event)
    assert problems
    assert any(why in problem for problem in problems)
