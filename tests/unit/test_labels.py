"""Labels: set by the application, joined when nested, scoped to their block."""

from __future__ import annotations

import threading

import pytest

from polars_telemetry.export import semconv
from polars_telemetry.labels import current_label, label


def test_no_label_outside_a_block():
    assert current_label() is None


def test_nested_labels_join_into_a_path():
    with label("tpch"), label("q3"):
        assert current_label() == "tpch/q3"


def test_a_label_ends_with_its_block():
    with label("outer"):
        with label("inner"):
            pass
        assert current_label() == "outer"
    assert current_label() is None


def test_an_exception_does_not_leave_a_label_behind():
    with pytest.raises(RuntimeError), label("doomed"):
        raise RuntimeError
    assert current_label() is None


@pytest.mark.parametrize("bad", ["", "   "])
def test_an_empty_label_is_refused(bad):
    with pytest.raises(ValueError, match="non-empty"), label(bad):
        pass


def test_threads_do_not_see_each_others_labels():
    """polars records the label of the thread that called collect()."""
    seen: dict[str, str | None] = {}
    inside = threading.Event()
    release = threading.Event()

    def labelled() -> None:
        with label("worker"):
            inside.set()
            release.wait()

    worker = threading.Thread(target=labelled)
    worker.start()
    inside.wait()
    seen["main"] = current_label()
    release.set()
    worker.join()
    assert seen["main"] is None


def test_a_label_is_never_a_metric_dimension():
    assert semconv.QUERY_LABEL not in semconv.METRIC_DIMENSIONS
