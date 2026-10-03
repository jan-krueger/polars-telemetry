"""Attributing a query to the line of code that ran it."""

from __future__ import annotations

import os
from uuid import uuid4

import polars

from polars_telemetry._callsite import _SKIP, CallSite, caller
from polars_telemetry.export import semconv
from polars_telemetry.export.attributes import query_attributes
from polars_telemetry.export.profile import build_profile
from polars_telemetry.model.types import Query


def test_the_calling_frame_is_reported():
    site = caller()
    assert site is not None
    assert site.filepath == __file__
    assert site.function == "test_the_calling_frame_is_reported"
    assert site.lineno > 0


def _helper() -> CallSite | None:
    """A deeper frame still reports itself, not its caller."""
    return caller()


def test_the_innermost_user_frame_wins():
    site = _helper()
    assert site is not None
    assert site.function == "_helper"


def test_polars_frames_are_skipped():
    """polars calls us from inside its own package; that is never the answer."""
    seen: list[CallSite | None] = []

    def record(frame):
        seen.append(caller())
        return frame

    polars.LazyFrame({"a": [1]}).map_batches(record).collect()
    assert len(seen) == 1
    assert seen[0] is not None
    assert seen[0].filepath == __file__


def test_only_the_two_package_directories_are_skipped():
    """The parent would be site-packages once installed, skipping every library."""
    import polars_telemetry
    from polars_telemetry._callsite import _SKIP

    package = os.path.dirname(polars_telemetry.__file__) + os.sep
    assert package in _SKIP
    assert os.path.dirname(os.path.dirname(polars_telemetry.__file__)) + os.sep not in _SKIP
    assert os.path.dirname(polars.__file__) + os.sep in _SKIP


def test_a_package_sharing_a_prefix_is_not_skipped():
    """`polars_helpers` beside `polars` must not be mistaken for it."""
    sibling = os.path.dirname(polars.__file__) + "_helpers" + os.sep + "run.py"
    assert not sibling.startswith(_SKIP)


def test_code_without_a_file_is_not_reported():
    """exec, eval and the REPL name nothing a reader could open."""
    scope: dict[str, object] = {"caller": caller}
    exec(compile("site = caller()", "<string>", "exec"), scope)  # noqa: S102
    assert scope["site"] is None


# --- export -----------------------------------------------------------------

SITE = CallSite(filepath="/srv/app/pipeline.py", lineno=142, function="build_report")


def _query(call_site: CallSite | None) -> Query:
    return Query(query_id=uuid4(), wall_ms=1.0, plan={}, call_site=call_site)


def test_the_span_carries_otel_code_attributes():
    attrs = query_attributes(_query(SITE))
    assert attrs[semconv.CODE_FILE_PATH] == "/srv/app/pipeline.py"
    assert attrs[semconv.CODE_LINE_NUMBER] == 142
    assert attrs[semconv.CODE_FUNCTION_NAME] == "build_report"


def test_a_query_without_a_call_site_omits_the_attributes():
    attrs = query_attributes(_query(None))
    assert semconv.CODE_FILE_PATH not in attrs
    assert semconv.CODE_LINE_NUMBER not in attrs
    assert semconv.CODE_FUNCTION_NAME not in attrs


def test_the_profile_carries_the_call_site():
    document = build_profile(_query(SITE))
    assert document["call_site"] == {
        "filepath": "/srv/app/pipeline.py",
        "lineno": 142,
        "function": "build_report",
    }


def test_the_profile_records_its_absence_explicitly():
    assert build_profile(_query(None))["call_site"] is None


def test_the_call_site_is_never_a_metric_dimension():
    """Line numbers churn on every edit; a dashboard must not restart with them."""
    code_attributes = {
        semconv.CODE_FILE_PATH,
        semconv.CODE_LINE_NUMBER,
        semconv.CODE_FUNCTION_NAME,
    }
    assert semconv.METRIC_DIMENSIONS.isdisjoint(code_attributes)
