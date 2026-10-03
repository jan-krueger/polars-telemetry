"""Plan-derived span attributes, and literal redaction."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.export import semconv
from polars_telemetry.export.attributes import query_attributes, redact
from polars_telemetry.model.diagnostics import Diagnostics
from polars_telemetry.model.types import Query

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


@pytest.fixture
def query():
    return Query(
        query_id=uuid4(),
        wall_ms=20.0,
        plan=build_plan(json.loads((FIXTURE / "physical.json").read_text())),
        logical=build_plan(json.loads((FIXTURE / "ir.json").read_text())),
        metrics=build_metrics(json.loads((FIXTURE / "metrics.json").read_text())),
    )


# --- redaction --------------------------------------------------------------


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ('col("email") == "jan@example.com"', 'col("email") == "<str>"'),
        ('col("amount") > 60.0', 'col("amount") > <num>'),
        ('col("a").sum().alias("total")', 'col("a").sum().alias("total")'),
        ('col("s").str.starts_with(["999"])', 'col("s").str.starts_with(["<str>"])'),
    ],
)
def test_redaction_masks_literals_but_keeps_structure(expression, expected):
    assert redact(expression) == expected


def test_redaction_preserves_column_names():
    """Column names are structure, not user data; they must survive."""
    assert "email" in redact('col("email") == "someone@example.com"')


def test_redaction_removes_the_literal_value():
    assert "someone@example.com" not in redact('col("email") == "someone@example.com"')


def test_redaction_leaves_internal_identifiers_alone():
    assert redact('col("_POLARS_TMP_1")') == 'col("_POLARS_TMP_1")'


# --- query attributes -------------------------------------------------------


def _number(attrs, key) -> float:
    value = attrs[key]
    assert isinstance(value, (int, float)), f"{key} is {type(value).__name__}"
    return float(value)


def _sequence(attrs, key) -> tuple[str, ...]:
    value = attrs[key]
    assert isinstance(value, tuple), f"{key} is {type(value).__name__}"
    return value


def test_core_attributes_are_present(query):
    attrs = query_attributes(query)
    assert attrs[semconv.ENGINE] == "streaming"
    assert attrs[semconv.NODE_COUNT] == len(query.plan)
    assert _number(attrs, semconv.CPU_MS) > 0
    assert attrs[semconv.QUERY_ID]


def test_plan_shape_is_summarised(query):
    attrs = query_attributes(query)
    assert attrs[semconv.SCAN_COUNT] == 2
    assert attrs[semconv.JOIN_COUNT] == 1
    assert attrs[semconv.GROUPBY_COUNT] == 1
    assert "orders.parquet" in _sequence(attrs, semconv.SCAN_SOURCES)
    assert attrs[semconv.JOIN_TYPES] == ("INNER",)


def test_groupby_keys_use_the_users_column_names(query):
    """The physical plan rewrites keys to _POLARS_TMP_N; the IR does not."""
    keys = _sequence(query_attributes(query), semconv.GROUPBY_KEYS)
    assert any("segment" in key for key in keys)
    assert not any("_POLARS_TMP" in key for key in keys)


def test_physical_plan_alone_would_lose_the_names(query):
    """Guards the fallback: it is worse, and we should know if we land on it."""
    physical_only = Query(
        query_id=query.query_id, wall_ms=query.wall_ms, plan=query.plan, metrics=query.metrics
    )
    keys = _sequence(query_attributes(physical_only), semconv.GROUPBY_KEYS)
    assert any("_POLARS_TMP" in key for key in keys)


def test_hottest_node_is_reported(query):
    attrs = query_attributes(query)
    assert attrs[semconv.HOT_NODE_KIND]
    assert 0 < _number(attrs, semconv.HOT_NODE_SHARE) <= 1


def test_predicates_are_redacted_on_request(query):
    plain = query_attributes(query, redact_literals=False)
    masked = query_attributes(query, redact_literals=True)

    assert any("10" in p for p in _sequence(plain, semconv.SCAN_PREDICATES))
    assert all("<num>" in p for p in _sequence(masked, semconv.SCAN_PREDICATES))


def test_every_user_data_attribute_is_declared():
    """CARRIES_USER_DATA is a promise in the README; keep it honest."""
    emitted = {
        semconv.SCAN_SOURCES,
        semconv.SCAN_PREDICATES,
        semconv.JOIN_KEYS,
        semconv.GROUPBY_KEYS,
    }
    assert emitted == semconv.CARRIES_USER_DATA


def test_metric_dimensions_stay_bounded():
    """Plan literals must never become metric attributes."""
    assert semconv.METRIC_DIMENSIONS.isdisjoint(semconv.CARRIES_USER_DATA)


def test_attributes_on_a_query_without_metrics():
    empty = Query(query_id=uuid4(), wall_ms=1.0, plan={})
    attrs = query_attributes(empty)
    assert attrs[semconv.NODE_COUNT] == 0
    assert semconv.CPU_MS not in attrs


def test_attribute_values_are_otlp_legal(query):
    """OTLP accepts scalars and homogeneous sequences of one scalar type.

    A mixed-type sequence serialises at export time, far from the code that
    produced it, so it is worth catching here.
    """
    scalars = (str, bool, int, float)
    for key, value in query_attributes(query, redact_literals=True).items():
        if isinstance(value, tuple):
            assert value, f"{key}: empty sequence"
            types = {type(item) for item in value}
            assert len(types) == 1, f"{key}: mixed types {types}"
            assert types.pop() in scalars, f"{key}: non-scalar sequence"
        else:
            assert isinstance(value, scalars), f"{key}: {type(value).__name__}"


def test_scan_columns_counts_what_was_read_not_the_file_width(query):
    """projected_file_columns is on the physical plan; the IR has file_columns.

    Reading the IR reports the width of the file, which is the inverse of the
    signal this attribute is for.
    """
    attrs = query_attributes(query)
    read = sum(
        len(node.properties["projected_file_columns"])
        for node in query.plan.values()
        if isinstance(node.properties.get("projected_file_columns"), list)
    )
    assert attrs[semconv.SCAN_COLUMNS] == read


@pytest.mark.parametrize(
    "field",
    [f.name for f in dataclasses.fields(Diagnostics)],
)
def test_every_diagnostic_reaches_the_span(field):
    """A diagnostic computed but never attached is invisible to every backend."""
    from polars_telemetry.export.attributes import _add_diagnostics

    empty: dict[str, object] = {}
    _add_diagnostics(empty, Diagnostics())  # type: ignore[arg-type]

    attrs: dict[str, object] = {}
    _add_diagnostics(attrs, Diagnostics(**{field: 1}))  # type: ignore[arg-type]

    assert set(attrs) - set(empty), f"Diagnostics.{field} maps to no span attribute"
