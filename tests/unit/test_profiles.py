"""Profile documents read back into the model."""

from __future__ import annotations

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
