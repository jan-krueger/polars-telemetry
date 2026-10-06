from __future__ import annotations

from polars_telemetry.adapter.build import build_metrics
from polars_telemetry.adapter.decode import metrics_problems
from polars_telemetry.model.types import COUNTER_NAMES, CustomMetric


def _record(**extra: object) -> dict[str, object]:
    return {**dict.fromkeys(COUNTER_NAMES, 0), "phys_node_key": 1, "done": True, **extra}


def test_a_record_with_or_without_custom_metrics_meets_the_contract():
    groups = [{"key": "group_by.actual_groups", "unit": "1", "value": 3}]
    assert metrics_problems([_record()]) == []
    assert metrics_problems([_record(custom=groups)]) == []
    assert metrics_problems([_record(custom=[{"key": "x", "unit": "ns", "value": None}])]) == []


def test_malformed_custom_metrics_are_reported():
    assert metrics_problems([_record(custom={"key": "x"})])
    assert metrics_problems([_record(custom=[{"key": "x", "unit": "1", "value": "3"}])])


def test_custom_metrics_are_read_into_the_model():
    entries = [
        {"key": "group_by.actual_groups", "unit": "1", "value": 3},
        {"key": "group_by.estimated_groups", "unit": "1", "value": None},
        "not a metric",
    ]
    (metric,) = build_metrics([_record(custom=entries)]).values()
    assert metric.custom == (
        CustomMetric("group_by.actual_groups", "1", 3),
        CustomMetric("group_by.estimated_groups", "1", None),
    )
    assert build_metrics([_record()])[1].custom == ()
