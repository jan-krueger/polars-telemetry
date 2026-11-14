"""The polars-telemetry command."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from polars_telemetry.cli import _insights, main

EXAMPLE = Path(__file__).parents[2] / "examples" / "tpch-sf1.jsonl"


def _timed(line: str, *, blocking: bool) -> str:
    document = json.loads(line)
    step = 1_000_000 if blocking else 0
    if blocking:
        document["wall_ms"] = 1.0
    for node in document["plan"]["physical"]:
        if node["kind"] == "GroupBy" and node.get("metrics"):
            node["metrics"].update(
                max_state_update_time_ns=step, max_poll_time_ns=step, total_time_ns=step
            )
    return json.dumps(document)


@pytest.fixture
def q20(tmp_path: Path) -> Path:
    lines = [line for line in EXAMPLE.read_text().splitlines() if '"tpch/q20"' in line]
    timed = [_timed(line, blocking=i == 0) for i, line in enumerate(lines)]
    session = tmp_path / "q20.jsonl"
    session.write_text("\n".join([*timed, "not a profile"]) + "\n")
    return session


def run(*argv: str) -> tuple[int, str]:
    import argparse

    out = io.StringIO()
    parser_args = argparse.Namespace(
        files=[Path(a) for a in argv if not a.startswith("--")],
        format="json" if "--json" in argv else "text",
        all="--all" in argv,
        fail_on="warn" if "--fail-on-warn" in argv else None,
        write=None,
    )
    return _insights(parser_args, out), out.getvalue()


def test_text_lists_warnings_and_counts_the_rest(q20: Path):
    code, text = run(str(q20))
    assert code == 0
    assert "Deduplication removes no rows  [redundant_aggregation, GroupBy #" in text
    assert "line 4 skipped" in text
    assert text.rstrip().endswith("3 queries: 1 warning, 2 information")


def test_json_carries_every_finding_with_its_schema(q20: Path):
    _, text = run(str(q20), "--json")
    records = json.loads(text)
    assert [r["insights"]["schema"] for r in records] == ["insights@1"] * 3
    assert sum(len(r["insights"]["findings"]) for r in records) == 3


def test_fail_on_turns_a_warning_into_a_failing_exit_code(q20: Path):
    assert run(str(q20), "--fail-on-warn")[0] == 1


def test_write_adds_insights_and_keeps_every_line(q20: Path, tmp_path: Path):
    target = tmp_path / "with-insights.jsonl"
    assert main(["insights", str(q20), "--write", str(target), "--format", "json"]) == 0
    lines = target.read_text().splitlines()
    assert len(lines) == 4
    assert lines[-1] == "not a profile"
    assert all("insights" in json.loads(line) for line in lines[:3])


def test_a_file_that_cannot_be_read_is_reported_and_the_rest_still_run(
    q20: Path, tmp_path: Path, capsys
):
    missing = tmp_path / "missing.jsonl"
    assert main(["insights", str(missing), str(tmp_path), str(q20)]) == 2
    captured = capsys.readouterr()
    assert f"cannot read {missing}: No such file or directory" in captured.err
    assert f"cannot read {tmp_path}: Is a directory" in captured.err
    assert captured.out.rstrip().endswith("3 queries: 1 warning, 2 information")


def test_damaged_lines_and_events_pass_through_write_unchanged(q20: Path, tmp_path: Path):
    damaged = b'\xff\xfe{"cut'
    event = b'{"schema":"polars-telemetry/events@1","seq":1,"type":"process"}'
    session = tmp_path / "damaged.jsonl"
    session.write_bytes(q20.read_bytes() + damaged + b"\n" + event + b"\n")
    target = tmp_path / "out.jsonl"
    assert main(["insights", str(session), "--write", str(target), "--format", "json"]) == 0
    lines = target.read_bytes().splitlines()
    assert lines[-2:] == [damaged, event]
    assert all("insights" in json.loads(line) for line in lines[:3])


def test_a_plan_with_a_cycle_is_skipped_rather_than_followed(tmp_path: Path):
    document = json.loads(EXAMPLE.read_text().splitlines()[0])
    first = document["plan"]["physical"][0]
    first["inputs"] = [first["id"]]
    session = tmp_path / "cycle.jsonl"
    session.write_text(json.dumps(document) + "\n")
    code, text = run(str(session))
    assert code == 0
    assert "line 1 skipped: plan.physical has a cycle" in text
