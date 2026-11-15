"""Queries run inside another query's Python UDF."""

from __future__ import annotations

import json
import threading

import pytest

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry.adapter.profiles import read_profile  # noqa: E402
from polars_telemetry.export.profile import build_profile  # noqa: E402

pytestmark = [pytest.mark.e2e]


def _small() -> None:
    polars.LazyFrame({"x": [1, 2, 3]}).select(polars.col("x").sum()).collect()


def _outer(udf) -> None:
    polars.LazyFrame({"a": [1, 2]}).map_batches(udf).collect()


def _inner_twice(frame):
    _small()
    _small()
    return frame


@pytest.mark.parametrize("engine", ["streaming", "in-memory"])
def test_a_query_inside_a_udf_names_the_query_it_ran_in(engine):
    def udf(frame):
        _small()
        return frame

    with polars_telemetry.profile() as session:
        polars.LazyFrame({"a": [1, 2]}).map_batches(udf).collect(engine=engine)
    inner, outer = session.queries
    assert outer.parent_query_id is None
    assert inner.parent_query_id == outer.query_id


def test_every_inner_query_names_the_same_outer_and_the_next_query_none():
    with polars_telemetry.profile() as session:
        _outer(_inner_twice)
        _small()
    first, second, outer, after = session.queries
    assert first.parent_query_id == second.parent_query_id == outer.query_id
    assert (outer.parent_query_id, after.parent_query_id) == (None, None)


def test_an_inner_query_that_fails_leaves_no_parent_behind():
    def failing(frame):
        with pytest.raises(polars.exceptions.ColumnNotFoundError):
            polars.LazyFrame({"x": [1]}).select("missing").collect()
        return frame

    with polars_telemetry.profile() as session:
        _outer(failing)
        _small()
    assert session.queries[-1].parent_query_id is None
    assert session.queries[0].failed


def test_queries_on_other_threads_do_not_nest():
    def udf(frame):
        thread = threading.Thread(target=_small)
        thread.start()
        thread.join()
        return frame

    with polars_telemetry.profile() as session:
        _outer(udf)
    assert all(q.parent_query_id is None for q in session.queries)


def test_the_parent_survives_a_profile_written_and_read_back():
    with polars_telemetry.profile() as session:
        _outer(_inner_twice)
    inner = session.queries[0]
    document = json.loads(json.dumps(build_profile(inner), default=str))
    assert document["parent_query_id"] == str(inner.parent_query_id)
    assert read_profile(document).parent_query_id == inner.parent_query_id
    assert "parent_query_id" not in build_profile(session.queries[-1])
