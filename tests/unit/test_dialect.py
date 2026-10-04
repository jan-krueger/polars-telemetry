"""polars' node vocabulary, mapped onto roles."""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.adapter.dialect import described, facets, role_of, unknown_kinds
from polars_telemetry.model.diagnostics import derive
from polars_telemetry.model.types import NodeRole, Query
from tests.fixture_paths import latest_fixture

FIXTURE = latest_fixture()


# PhysNodeKind descriptions in polars-stream's to_description.rs at py-1.44.2,
# py-2.0.0-rc.2 and main, without the Default and Other fallbacks.
POLARS_PHYSICAL_KINDS = sorted(
    {
        "AsOfJoin",
        "BackwardFill",
        "CallbackSink",
        "ColumnarFunction",
        "CrossJoin",
        "CumAgg",
        "DynamicGroupBy",
        "DynamicSlice",
        "EquiJoin",
        "Ewm",
        "FileSink",
        "Filter",
        "ForwardFill",
        "Gather",
        "GatherEvery",
        "GroupBy",
        "InMemoryAsOfJoin",
        "InMemoryIEJoin",
        "InMemoryJoin",
        "InMemoryMap",
        "InMemorySink",
        "InMemorySource",
        "InputIndependentSelect",
        "Interpolate",
        "IsFirstDistinct",
        "IsSorted",
        "Map",
        "MergeJoin",
        "MergeSorted",
        "MultiScan",
        "Multiplexer",
        "NegativeSlice",
        "OrderedUnion",
        "PartitionSink",
        "PeakMax",
        "PeakMin",
        "PythonScan",
        "RangeJoin",
        "Reduce",
        "Repeat",
        "Rle",
        "RleId",
        "RollingFixedWindowFunction",
        "RollingGroupBy",
        "Select",
        "SemiAntiJoin",
        "Shift",
        "SimpleProjection",
        "SinkMultiple",
        "Slice",
        "Sort",
        "SortedGroupBy",
        "SortedUnique",
        "StrptimeInfer",
        "TopK",
        "UnorderedUnion",
        "Window",
        "WithRowIndex",
        "Zip",
    }
)


def test_every_physical_kind_polars_emits_has_a_role():
    assert unknown_kinds(POLARS_PHYSICAL_KINDS) == []


@pytest.mark.parametrize(
    ("kind", "properties", "role"),
    [
        ("Join", {"how": "INNER"}, NodeRole.JOIN),
        ("Join", {"how": "SEMI"}, NodeRole.SEMI_ANTI_JOIN),
        ("Join", {"how": "ANTI"}, NodeRole.SEMI_ANTI_JOIN),
        ("EquiJoin", {}, NodeRole.JOIN),
        ("SemiAntiJoin", {}, NodeRole.SEMI_ANTI_JOIN),
        ("IEJoin", {}, NodeRole.THETA_JOIN),
        ("CrossJoin", {}, NodeRole.CROSS_JOIN),
        ("Select", {"extend_original": True}, NodeRole.MAP),
        ("Select", {"extend_original": False}, NodeRole.PROJECTION),
        ("HStack", {}, NodeRole.MAP),
        ("MapFunction", {"function": "RENAME"}, NodeRole.RENAME),
        ("MapFunction", {"function": "EXPLODE [channels]"}, NodeRole.FUNCTION),
        ("Scan", {}, NodeRole.SCAN),
        ("MultiScan", {}, NodeRole.SCAN),
        ("InMemorySink", {}, NodeRole.SINK),
        ("Multiplexer", {}, NodeRole.ENGINE),
        ("NeverHeardOfIt", {}, NodeRole.UNKNOWN),
    ],
)
def test_role_of(kind, properties, role):
    assert role_of(kind, properties) is role


def test_the_ir_and_physical_names_for_one_operator_share_a_role():
    """`Join`/`EquiJoin` and `Scan`/`MultiScan` are the same thing to a reader."""
    assert role_of("Join", {"how": "INNER"}) is role_of("EquiJoin", {})
    assert role_of("Scan", {}) is role_of("MultiScan", {})


def test_a_renamed_operator_is_reported_not_silently_dropped():
    """The failure this module exists to make loud."""
    physical = json.loads((FIXTURE / "physical.json").read_text())
    renamed = copy.deepcopy(physical)
    for record in renamed:
        if record["properties"]["type"] == "EquiJoin":
            record["properties"]["type"] = "HashJoin"

    assert unknown_kinds(r["properties"]["type"] for r in physical) == []
    assert unknown_kinds(r["properties"]["type"] for r in renamed) == ["HashJoin"]


def test_downstream_reads_roles_not_kind_names():
    """Once the dialect maps a renamed kind, nothing downstream needs touching:
    the same plan under a new kind name derives the same diagnostics."""
    plan = build_plan(json.loads((FIXTURE / "physical.json").read_text()))
    metrics = build_metrics(json.loads((FIXTURE / "metrics.json").read_text()))
    renamed = {
        node_id: replace(node, kind="HashJoin") if node.kind == "EquiJoin" else node
        for node_id, node in plan.items()
    }
    assert any(node.kind == "HashJoin" for node in renamed.values())

    before = derive(Query(query_id=uuid4(), wall_ms=1.0, plan=plan, metrics=metrics))
    after = derive(Query(query_id=uuid4(), wall_ms=1.0, plan=renamed, metrics=metrics))
    assert before.join_growth is not None
    assert after.join_growth == before.join_growth


# --- facets -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("predicate", "kept"),
    [
        (['col("k").dynamic_predicate()'], ()),
        ('col("k").dynamic_predicate()', ()),
        ('(col("a") > 1) & col("k").dynamic_predicate()', ('(col("a") > 1)',)),
        ('col("k").dynamic_predicate() & (col("a") > 1)', ('(col("a") > 1)',)),
        (['col("a") > 1', 'col("k").dynamic_predicate()'], ('col("a") > 1',)),
    ],
)
def test_a_runtime_threshold_polars_pushes_into_a_scan_is_not_a_user_predicate(predicate, kept):
    scan = facets(NodeRole.SCAN, {"predicate": predicate})["scan"]
    assert scan.predicates == kept
    assert scan.predicate_pushed is bool(kept)


def test_a_predicate_reads_the_same_from_either_plan():
    """The IR lists predicates; the physical plan gives one string."""
    from polars_telemetry.adapter.dialect import facets

    ir = facets(NodeRole.SCAN, {"predicate": ['col("a") > 1']})["scan"]
    physical = facets(NodeRole.SCAN, {"predicate": 'col("a") > 1'})["scan"]
    assert ir.predicates == physical.predicates == ('col("a") > 1',)
    assert ir.predicate_pushed
    assert physical.predicate_pushed


def test_group_keys_read_the_same_from_either_plan():
    from polars_telemetry.adapter.dialect import facets

    flat = facets(NodeRole.AGGREGATION, {"keys": ['col("g")']})["aggregation"]
    nested = facets(NodeRole.AGGREGATION, {"key_per_input": [['col("g")']]})["aggregation"]
    assert flat.keys == nested.keys == ('col("g")',)
    assert flat.grouped
    assert nested.grouped


def test_a_global_reduction_is_not_a_group_by():
    from polars_telemetry.adapter.dialect import facets

    assert facets(NodeRole.AGGREGATION, {})["aggregation"].grouped is False


def test_a_malformed_property_degrades_rather_than_raises():
    """polars changing a value's shape must cost the facet field, not the plan."""
    from polars_telemetry.adapter.dialect import facets

    scan = facets(NodeRole.SCAN, {"first_source": 7, "file_columns": "many"})["scan"]
    assert scan.source is None
    assert scan.file_columns is None


def test_nodes_without_a_facet_role_carry_none():
    plan = build_plan(json.loads((FIXTURE / "physical.json").read_text()))
    for node in plan.values():
        if node.role is NodeRole.SCAN:
            assert node.scan is not None
        else:
            assert node.scan is None


def test_the_placeholder_polars_writes_for_an_undescribed_node_is_dropped():
    placeholder = "error: prepare_visualization was not set during conversion"
    assert described({"type": "InMemoryMap", "format_str": placeholder}) == {"type": "InMemoryMap"}
    assert described({"format_str": "SELECT [x]"}) == {"format_str": "SELECT [x]"}
