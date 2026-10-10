"""The shared sampler of running queries."""

from __future__ import annotations

import threading
import time
from typing import Any
from uuid import uuid4

import msgpack

from polars_telemetry.adapter.handle import MetricsHandle
from polars_telemetry.adapter.sampler import Sampler
from polars_telemetry.model.types import COUNTER_NAMES, Progress


def _row(node: int, rows: int) -> dict[str, Any]:
    return {
        **dict.fromkeys(COUNTER_NAMES, 0),
        "phys_node_key": node,
        "rows_sent": rows,
        "done": False,
    }


class Growing:
    """A metrics handle whose counters grow on node 1 and stay put on node 2."""

    def __init__(self) -> None:
        self.calls = 0
        self.inside = threading.Event()
        self.release = threading.Event()
        self.release.set()

    def snapshot_query_metrics(self) -> bytes:
        self.calls += 1
        self.inside.set()
        self.release.wait()
        return msgpack.packb([_row(1, self.calls), _row(2, 7)])


def _watch(sampler: Sampler, raw: Growing, interval: float = 0.01):
    announced: list[int] = []
    samples: list[Progress] = []
    query_id = uuid4()
    sampler.watch(
        query_id,
        MetricsHandle(raw),
        started=time.perf_counter(),
        interval=interval,
        announce=lambda: announced.append(len(samples)),
        deliver=samples.append,
    )
    return query_id, announced, samples


def _until(condition, timeout: float = 2.0) -> None:
    deadline = time.perf_counter() + timeout
    while not condition():
        assert time.perf_counter() < deadline, "timed out"
        time.sleep(0.005)


def test_a_query_is_announced_once_before_its_first_sample():
    sampler = Sampler()
    query_id, announced, samples = _watch(sampler, Growing())
    _until(lambda: len(samples) >= 3)
    sampler.unwatch(query_id)
    assert announced == [0]


def test_the_first_sample_has_every_node_and_later_ones_only_what_changed():
    sampler = Sampler()
    query_id, _, samples = _watch(sampler, Growing())
    _until(lambda: len(samples) >= 3)
    sampler.unwatch(query_id)
    assert set(samples[0].nodes) == {1, 2}
    assert all(set(s.nodes) == {1} for s in samples[1:])
    assert [s.nodes[1].rows_sent for s in samples[:3]] == [1, 2, 3]
    assert all(s.query_id == query_id for s in samples)


def test_a_query_that_ends_before_its_first_sample_is_never_announced():
    sampler = Sampler()
    raw = Growing()
    query_id, announced, samples = _watch(sampler, raw, interval=5.0)
    sampler.unwatch(query_id)
    time.sleep(0.05)
    assert (announced, samples, raw.calls) == ([], [], 0)


def test_unwatch_waits_for_a_sample_in_progress_so_nothing_follows_it():
    sampler = Sampler()
    raw = Growing()
    raw.release.clear()
    query_id, _, samples = _watch(sampler, raw)
    _until(raw.inside.is_set)
    done = threading.Event()

    def stop() -> None:
        sampler.unwatch(query_id)
        done.set()

    threading.Thread(target=stop, daemon=True).start()
    assert not done.wait(0.05), "unwatch returned while a sample was being taken"
    raw.release.set()
    assert done.wait(2.0)
    delivered = len(samples)
    time.sleep(0.05)
    assert len(samples) == delivered


def _sampler_threads() -> int:
    return [t.name for t in threading.enumerate()].count("polars-telemetry-sampler")


def test_one_thread_samples_every_query():
    before = _sampler_threads()
    sampler = Sampler()
    first = _watch(sampler, Growing())
    second = _watch(sampler, Growing())
    _until(lambda: len(first[2]) >= 2 and len(second[2]) >= 2)
    sampler.unwatch(first[0])
    sampler.unwatch(second[0])
    assert _sampler_threads() == before + 1


def test_a_failing_snapshot_is_skipped_and_sampling_goes_on():
    class Flaky(Growing):
        def snapshot_query_metrics(self) -> bytes:
            if self.calls == 0:
                self.calls += 1
                raise RuntimeError("not yet")
            return super().snapshot_query_metrics()

    sampler = Sampler()
    query_id, announced, samples = _watch(sampler, Flaky())
    _until(lambda: len(samples) >= 2)
    sampler.unwatch(query_id)
    assert announced == [0]
