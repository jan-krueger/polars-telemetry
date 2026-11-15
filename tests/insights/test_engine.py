"""The engine: ranking, levels, isolation; never dropping a finding."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import ClassVar

from polars_telemetry.model.insights import Finding, evaluate
from polars_telemetry.model.insights.finding import Measure, Text, unit
from polars_telemetry.model.insights.rule import Rule
from polars_telemetry.model.insights.view import PlanView
from polars_telemetry.model.types import PlanNode
from tests.insights.plans import Plan


@dataclass(frozen=True)
class Seen:
    rows: int = unit("rows")
    note: str = "not a number"
    untagged: int = 3


class EveryFilter(Rule[Seen]):
    id: ClassVar[str] = "every_filter"

    def check(self, node: PlanNode, view: PlanView) -> Seen | None:
        return Seen(view.rows_sent(node) or 0) if node.kind == "Filter" else None

    def describe(self, evidence: Seen) -> Text:
        return Text(f"Filter sends {evidence.rows} rows", "")


class Applied(EveryFilter):
    id: ClassVar[str] = "applied"
    kind = "applied"


class Broken(EveryFilter):
    id: ClassVar[str] = "broken"

    def check(self, node: PlanNode, view: PlanView) -> Seen | None:
        raise RuntimeError("bug in a rule")


def plan() -> Plan:
    return (
        Plan()
        .node(1, "MultiScan", rows=1000, ms=10)
        .node(2, "Filter", (1,), rows=10, ms=0.5)
        .node(3, "Filter", (1,), rows=500, ms=60)
        .node(4, "Filter", (1,), rows=5, ms=0.1, blocked_ms=40)
    )


def test_problems_rank_by_the_larger_of_cpu_and_blocked_wall_time():
    found = evaluate(plan().query(wall_ms=100), [EveryFilter()])
    assert [f.node_id for f in found] == [3, 4, 2]
    assert found[1].impact.blocked_share == 0.4


def test_small_problems_are_information_and_are_never_dropped():
    found = {f.node_id: f.level for f in evaluate(plan().query(wall_ms=100_000), [EveryFilter()])}
    assert found == {2: "info", 3: "warn", 4: "info"}


def test_applied_facts_come_after_problems_in_plan_order():
    found = evaluate(plan().query(), [Applied(), EveryFilter()])
    assert [(f.kind, f.node_id) for f in found][-3:] == [
        ("applied", 2),
        ("applied", 3),
        ("applied", 4),
    ]
    assert {f.level for f in found if f.kind == "applied"} == {"applied"}


def test_a_failing_rule_is_reported_once_and_the_others_still_run(caplog):
    with caplog.at_level(logging.WARNING, logger="polars_telemetry"):
        found = evaluate(plan().query(), [Broken(), EveryFilter()])
        evaluate(plan().query(), [Broken()])
    assert {f.rule for f in found} == {"every_filter"}
    assert sum("broken" in r.getMessage() for r in caplog.records) == 1


def test_evidence_is_the_fields_tagged_with_a_unit():
    finding = evaluate(plan().query(), [EveryFilter()])[0]
    assert finding.evidence == (Measure("rows", 500, "rows"),)
    assert finding.to_dict()["evidence"] == [{"name": "rows", "value": 500, "unit": "rows"}]
    assert Finding.from_dict(finding.to_dict()).to_dict() == finding.to_dict()


def test_a_query_without_a_physical_plan_has_no_findings():
    query = plan().query()
    assert (
        evaluate(type(query)(query_id=query.query_id, wall_ms=1.0, plan={}), [EveryFilter()]) == ()
    )


def test_the_view_counts_a_shared_input_once_per_consumer():
    query = (
        Plan()
        .node(1, "Multiplexer", rows=3000)
        .node(2, "EquiJoin", (1, 3), rows=1000)
        .node(3, "MultiScan", rows=10)
        .node(4, "Select", (1,), rows=1000)
        .node(5, "Select", (1,), rows=1000)
        .query()
    )
    view = PlanView(query)
    assert view.larger_input_rows(query.plan[2]) == 1000


class AnyFilter(EveryFilter):
    id: ClassVar[str] = "any_filter"

    def describe(self, evidence: Seen) -> Text:
        return Text("A filter", "fix it")


def many_small_filters(count: int) -> Plan:
    built = Plan().node(1, "MultiScan", rows=1000, ms=1000)
    for node_id in range(2, count + 2):
        built = built.node(node_id, "Filter", (1,), rows=10, ms=0.5 if node_id != 5 else 0.9)
    return built


def test_the_same_finding_on_many_nodes_is_one_finding_with_their_sum():
    (finding,) = evaluate(many_small_filters(40).query(wall_ms=100_000), [AnyFilter()])
    assert finding.node_ids == tuple(range(2, 42))
    assert finding.node_id == 5
    assert finding.title == "A filter (40 nodes)"
    assert abs(finding.impact.cpu_share - (39 * 0.5 + 0.9) / (1000 + 39 * 0.5 + 0.9)) < 1e-9
    assert finding.level == "warn"


def test_findings_that_differ_stay_apart_and_one_alone_lists_no_nodes():
    found = evaluate(plan().query(), [EveryFilter()])
    assert len(found) == 3
    assert all(f.node_ids == () and "node_ids" not in f.to_dict() for f in found)


def test_the_nodes_of_a_merged_finding_survive_writing_and_reading():
    (finding,) = evaluate(many_small_filters(3).query(), [AnyFilter()])
    written = finding.to_dict()
    assert written["node_ids"] == [2, 3, 4]
    assert Finding.from_dict(written).to_dict() == written
