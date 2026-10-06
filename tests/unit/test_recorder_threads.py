"""polars may hand one observer several queries at once, each on its own thread."""

from __future__ import annotations

import threading
from uuid import uuid4

from polars_telemetry._safety import FailureTracker
from polars_telemetry.adapter.recorder import QueryRecorder
from polars_telemetry.config import Config
from polars_telemetry.model.types import Query

NIL = b"\xc0"


def _step(barrier: threading.Barrier, action) -> None:
    barrier.wait()
    action()


def test_interleaved_queries_on_two_threads_are_both_emitted():
    emitted: list[Query] = []
    recorder = QueryRecorder(Config(insights=False), emitted.append, FailureTracker("observer"))
    ids = [uuid4(), uuid4()]
    barrier = threading.Barrier(2)

    def query(query_id):
        for action in (
            lambda: recorder.started(query_id),
            lambda: recorder.planned(query_id, NIL, NIL, None),
            recorder.closed,
        ):
            _step(barrier, action)

    threads = [threading.Thread(target=query, args=(query_id,)) for query_id in ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(str(q.query_id) for q in emitted) == sorted(str(i) for i in ids)


def test_a_failure_then_a_close_still_emits_once():
    emitted: list[Query] = []
    recorder = QueryRecorder(Config(insights=False), emitted.append, FailureTracker("observer"))
    query_id = uuid4()
    recorder.started(query_id)
    recorder.planned(query_id, NIL, NIL, None)
    recorder.failed("boom")
    recorder.closed()
    assert [q.failed for q in emitted] == ["boom"]


def test_one_recorder_reused_for_queries_in_turn_emits_each():
    emitted: list[Query] = []
    recorder = QueryRecorder(Config(insights=False), emitted.append, FailureTracker("observer"))
    for _ in range(3):
        query_id = uuid4()
        recorder.started(query_id)
        recorder.planned(query_id, NIL, NIL, None)
        recorder.closed()
    assert len({q.query_id for q in emitted}) == 3
