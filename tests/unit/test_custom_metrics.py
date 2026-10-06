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


def test_malformed_custom_metrics_are_reported_without_costing_the_counters():
    from polars_telemetry.adapter.decode import metrics_additions, metrics_breaks

    for custom in ({"key": "x"}, [{"key": "x", "unit": "1", "value": "3"}]):
        assert metrics_breaks([_record(custom=custom)]) == []
        assert metrics_additions([_record(custom=custom)])
    (metric,) = build_metrics([_record(custom={"key": "x"}, rows_sent=5)]).values()
    assert (metric.rows_sent, metric.custom) == (5, ())


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


def test_the_plan_json_keeps_each_custom_metric_with_its_unit():
    import json
    from uuid import uuid4

    from polars_telemetry.adapter.build import build_plan
    from polars_telemetry.export.attributes import plan_json
    from polars_telemetry.model.types import Query

    entries = [{"key": "group_by.actual_groups", "unit": "1", "value": 3}]
    query = Query(
        query_id=uuid4(),
        wall_ms=1.0,
        plan=build_plan([{"id": 1, "input_ids": [], "properties": {"type": "GroupBy"}}]),
        metrics=build_metrics([_record(custom=entries)]),
    )
    (node,) = json.loads(plan_json(query))["physical"]
    assert node["custom"] == entries
