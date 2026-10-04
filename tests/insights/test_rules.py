"""Each rule on the smallest plan that shows its pattern, and on one that does not."""

from __future__ import annotations

from polars_telemetry.model.insights import Finding, evaluate
from polars_telemetry.model.insights.rules import RULES
from tests.insights.plans import Plan


def numbers(finding: Finding) -> dict[str, float]:
    return {m.name: m.value for m in finding.evidence}


def found(plan: Plan, rule: str, wall_ms: float = 100.0) -> list[Finding]:
    return [f for f in evaluate(plan.query(wall_ms=wall_ms)) if f.rule == rule]


def test_every_rule_has_a_unique_public_id():
    ids = [rule.id for rule in RULES]
    assert len(ids) == len(set(ids))
    assert all(i.isidentifier() and i.islower() for i in ids)


class TestInMemoryFallback:
    def test_reports_the_rows_handed_over_and_the_time_the_pipeline_waited(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=1_000_000, ms=5)
            .node(2, "InMemoryMap", (1,), rows=1_000_000, ms=40, blocked_ms=40)
        )
        (finding,) = found(plan, "in_memory_fallback")
        assert finding.impact.blocked_share == 0.4
        assert numbers(finding) == {"rows_in": 1_000_000, "longest_step": 40.0}

    def test_a_python_udf_is_not_reported_as_a_fallback(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=10)
            .node(2, "ColumnarFunction", (1,), name="python_udf")
        )
        assert found(plan, "in_memory_fallback") == []


class TestExplodingJoin:
    def test_fires_past_twice_the_larger_input_and_counts_the_rows_it_feeds(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=2_000, ms=1)
            .node(2, "MultiScan", rows=1_000, ms=1)
            .node(3, "EquiJoin", (1, 2), rows=10_000, ms=10)
            .node(4, "Select", (3,), rows=10_000, ms=30)
            .node(5, "GroupBy", (4,), rows=5, ms=8)
        )
        (finding,) = found(plan, "exploding_join")
        assert numbers(finding)["growth"] == 5.0
        assert round(finding.impact.cpu_share, 2) == 0.96

    def test_a_one_to_many_join_stays_quiet(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=100)
            .node(2, "MultiScan", rows=1_000_000)
            .node(3, "EquiJoin", (1, 2), rows=1_000_000)
        )
        assert found(plan, "exploding_join") == []


class TestCrossJoin:
    def test_says_how_little_the_next_filter_keeps(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=100_000)
            .node(2, "MultiScan", rows=50)
            .node(3, "CrossJoin", (1, 2), rows=5_000_000)
            .node(4, "Filter", (3,), rows=500, ms=10)
        )
        (finding,) = found(plan, "cross_join")
        assert finding.title == "Cross join, then a filter keeps 0.01% of the pairs"

    def test_a_scalar_broadcast_is_no_cross_join_finding(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=100_000)
            .node(2, "Reduce", rows=1)
            .node(3, "CrossJoin", (1, 2), rows=100_000)
        )
        assert found(plan, "cross_join") == []


class TestRepeatedStringScan:
    def test_counts_calls_on_one_column_and_suggests_one_pass(self):
        chain = "".join(f'.str.replace(["{i}"], ["x"])' for i in range(13))
        plan = (
            Plan()
            .node(1, "MultiScan", rows=10)
            .node(2, "Select", (1,), selectors=[f'col("s"){chain}'])
        )
        (finding,) = found(plan, "repeated_string_scan")
        assert finding.title == "13x `str.replace` on one column, one pass each"
        assert "`str.replace_many`" in finding.fix

    def test_three_calls_are_not_enough(self):
        expressions = [f'col("s").str.contains(["{i}"])' for i in range(3)]
        plan = Plan().node(1, "MultiScan", rows=10).node(2, "Select", (1,), selectors=expressions)
        assert found(plan, "repeated_string_scan") == []


class TestRedundantAggregation:
    def dedup(self, rows_out: int, *, asked: bool = True) -> Plan:
        plan = (
            Plan()
            .node(1, "MultiScan", rows=1_000_000)
            .node(
                2, "GroupBy", (1,), rows=rows_out, aggs_per_input=[['col("v").first().alias("v")']]
            )
        )
        if asked:
            plan.logical(10, "Distinct")
        return plan

    def test_a_deduplication_that_removes_almost_nothing(self):
        (finding,) = found(self.dedup(999_998), "redundant_aggregation")
        assert finding.title == "Deduplication removes 0.0002% of rows"

    def test_one_that_removes_real_duplicates_stays_quiet(self):
        assert found(self.dedup(900_000), "redundant_aggregation") == []

    def test_polars_internal_deduplication_is_not_blamed_on_the_query(self):
        assert found(self.dedup(1_000_000, asked=False), "redundant_aggregation") == []

    def test_an_aggregation_that_computes_values_is_no_deduplication(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=1_000)
            .node(2, "GroupBy", (1,), rows=1_000, aggs_per_input=[['col("v").sum().alias("v")']])
            .logical(10, "Distinct")
        )
        assert found(plan, "redundant_aggregation") == []
