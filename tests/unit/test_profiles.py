"""Profile documents read back into the model."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from polars_telemetry.adapter.profiles import ProfileError, Skipped, read_profile, read_profiles
from polars_telemetry.export.profile import build_profile
from polars_telemetry.model.types import Query
from tests.tools.viewer_fixture import profile_document

EXAMPLES = Path(__file__).parents[2] / "examples"


def test_a_profile_read_back_writes_the_same_document():
    document = json.loads(json.dumps(profile_document(), default=str))
    assert json.loads(json.dumps(build_profile(read_profile(document)), default=str)) == document


def test_every_example_profile_reads_with_its_plan_and_counters():
    for path in sorted(EXAMPLES.glob("*.jsonl")):
        read = list(read_profiles(path))
        queries = [r for r in read if isinstance(r, Query)]
        assert len(queries) == len(read), path.name
        assert all(q.plan and q.metrics and q.wall_ms > 0 for q in queries)


def test_a_line_that_is_no_profile_is_reported_not_fatal(tmp_path):
    good = json.dumps(profile_document(), default=str)
    session = tmp_path / "session.jsonl"
    session.write_text(f"{good}\nnot json\n\n{json.dumps({'schema': 'other@1'})}\n{good}\n")
    read = list(read_profiles(session))
    assert [type(r).__name__ for r in read] == ["Query", "Skipped", "Skipped", "Query"]
    assert [r.line for r in read if isinstance(r, Skipped)] == [2, 4]


def test_another_schema_is_refused():
    with pytest.raises(ProfileError):
        read_profile({"schema": "polars-telemetry/profile@2"})


def _session(tmp_path: Path, *lines: bytes) -> Path:
    path = tmp_path / "session.jsonl"
    path.write_bytes(b"".join(line + b"\n" for line in lines))
    return path


def _document(**changes: object) -> dict[str, object]:
    document = json.loads(json.dumps(profile_document(), default=str))
    document.update(changes)
    return document


def _line(document: object) -> bytes:
    return json.dumps(document).encode()


def _skipped(path: Path) -> list[str]:
    return [r.reason for r in read_profiles(path) if isinstance(r, Skipped)]


def _with_nodes(change) -> dict[str, object]:
    document = _document()
    change(document["plan"]["physical"])  # type: ignore[index]
    return document


def _self_loop(nodes: list[dict[str, object]]) -> None:
    nodes[0]["inputs"] = [nodes[0]["id"]]


def _ring(nodes: list[dict[str, object]]) -> None:
    for position, node in enumerate(nodes):
        node["inputs"] = [nodes[(position + 1) % len(nodes)]["id"]]


@pytest.mark.parametrize(
    ("line", "reason"),
    [
        (b"[]", "not a JSON object but a list"),
        (b"null", "not a JSON object but null"),
        (b"[" * 100_000 + b"]" * 100_000, "nested more than 64 levels deep"),
        (
            _line(_document(label=json.loads("[" * 100 + "]" * 100))),
            "nested more than 64 levels deep",
        ),
        (b'{"schema": "polars-telemetry/profile@1", "query_id"', "not valid JSON"),
        (b"\xff\xfe{}", "not UTF-8 text"),
        (_line(_document(plan=["nodes"])), "plan is a list, not an object"),
        (_line(_document(plan={"physical": "nodes"})), "plan.physical is a string, not a list"),
        (_line(_document(plan={"physical": [3]})), "plan.physical has an entry that is a number"),
        (_line(_document(plan={"logical": [{"id": "1"}]})), "plan.logical has a node without an"),
        (_line(_with_nodes(_self_loop)), "plan.physical has a cycle"),
        (_line(_with_nodes(_ring)), "plan.physical has a cycle"),
        (_line({"schema": "polars-telemetry/profile@1"}), "no query_id"),
    ],
)
def test_a_damaged_line_is_skipped_with_its_reason(tmp_path, line, reason):
    good = _line(_document())
    read = list(read_profiles(_session(tmp_path, good, line, good)))
    assert [type(r).__name__ for r in read] == ["Query", "Skipped", "Query"]
    assert read[1].line == 2  # type: ignore[union-attr]
    assert read[1].reason.startswith(reason)  # type: ignore[union-attr]


def test_values_out_of_range_read_as_missing(tmp_path):
    document = _document(
        wall_ms=10**400,
        planning_ms=float("inf"),
        started_unix_ns=float("nan"),
        label=["not", "text"],
        call_site={"filepath": 3},
        diagnostics=[],
        query_metrics={"io_total_active_ns": float("inf"), "num_threads": 8},
    )
    node = document["plan"]["physical"][0]  # type: ignore[index]
    node["metrics"]["total_time_ns"] = 10**400
    node["inputs"] = ["2", None, *node["inputs"]]
    document["insights"] = {"schema": "insights@1", "findings": [{"rule": "x"}]}
    (query,) = read_profiles(_session(tmp_path, _line(document)))
    assert isinstance(query, Query)
    assert (query.wall_ms, query.planning_ms, query.started_unix_ns) == (0.0, None, 0)
    assert (query.label, query.call_site, query.insights) == (None, None, None)
    assert query.query_metrics == {"num_threads": 8}
    assert query.metrics[node["id"]].total_time_ns == 0
    assert query.plan[node["id"]].inputs == tuple(node["inputs"][2:])


def test_a_gzip_session_reads_and_a_cut_off_one_says_where_it_ends(tmp_path):
    good = _line(_document()) + b"\n"
    whole = tmp_path / "session.jsonl.gz"
    whole.write_bytes(gzip.compress(good * 2))
    assert [type(r).__name__ for r in read_profiles(whole)] == ["Query", "Query"]
    cut = tmp_path / "cut.jsonl.gz"
    cut.write_bytes(gzip.compress(good * 2)[:-40])
    assert _skipped(cut)[-1] == "the gzip data ends or breaks here"


def test_a_session_may_start_with_a_byte_order_mark_and_use_crlf(tmp_path):
    good = _line(_document())
    path = _session(tmp_path, b"\xef\xbb\xbf" + good + b"\r", good + b"\r")
    assert [type(r).__name__ for r in read_profiles(path)] == ["Query", "Query"]


def test_an_event_recording_reads_as_its_finished_queries(tmp_path):
    events = "polars-telemetry/events@1"
    path = _session(
        tmp_path,
        _line({"schema": events, "seq": 1, "type": "process"}),
        _line({"schema": events, "seq": 2, "type": "query.started", "query_id": "x"}),
        _line({"schema": events, "seq": 3, "type": "query.finished", "profile": _document()}),
        _line({"schema": events, "seq": 4, "type": "query.finished", "profile": []}),
    )
    read = list(read_profiles(path))
    assert [type(r).__name__ for r in read] == ["Query", "Skipped"]
    assert read[1].reason == "not a JSON object but a list"  # type: ignore[union-attr]


def test_a_very_deep_plan_reads_without_recursing(tmp_path):
    document = _document()
    template = document["plan"]["physical"][0]  # type: ignore[index]
    chain = [{**template, "id": i, "inputs": [i - 1] if i else []} for i in range(5000)]
    document["plan"] = {"physical": chain, "logical": []}
    (query,) = read_profiles(_session(tmp_path, _line(document)))
    assert isinstance(query, Query)
    assert len(query.plan) == 5000
