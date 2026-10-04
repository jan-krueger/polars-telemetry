"""The polars-telemetry command."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from polars_telemetry.cli import _insights, main

EXAMPLE = Path(__file__).parents[2] / "examples" / "tpch-sf1.jsonl"


@pytest.fixture
def q20(tmp_path: Path) -> Path:
    lines = [line for line in EXAMPLE.read_text().splitlines() if '"tpch/q20"' in line]
    session = tmp_path / "q20.jsonl"
    session.write_text("\n".join([*lines, "not a profile"]) + "\n")
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
    assert text.rstrip().endswith("3 queries: 1 warnings, 2 information, 0 applied")


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
