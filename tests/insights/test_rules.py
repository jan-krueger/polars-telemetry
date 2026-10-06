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
    def chain(self, steps: list[tuple[str, str]]) -> Finding:
        text = "".join(f'.str.replace(["{p}", "{r}"])' for p, r in steps)
        plan = (
            Plan()
            .node(1, "MultiScan", rows=10)
            .node(2, "Select", (1,), selectors=[f'col("s"){text}'])
        )
        (finding,) = found(plan, "repeated_string_scan")
        return finding

    def test_independent_steps_merge_into_one_pass(self):
        finding = self.chain([(chr(ord("a") + i), "X") for i in range(13)])
        assert finding.title == "13x `str.replace` on one column, one pass each"
        assert (
            finding.fix == "if these are literal `replace_all`: merge into one `str.replace_many`"
        )

    def test_steps_that_interact_merge_only_into_safe_groups(self):
        steps = [("straße", "str."), ("ß", "ss"), ("ü", "ue"), (" ", ""), (".", "")]
        finding = self.chain(steps)
        assert numbers(finding)["replace_many_calls"] == 2
        assert finding.fix.endswith("merge into 2 `str.replace_many` calls, in order")

    def test_a_function_without_a_one_pass_form_is_not_reported(self):
        expressions = [f'col("s").str.slice([{i}, 2])' for i in range(5)]
        plan = Plan().node(1, "MultiScan", rows=10).node(2, "Select", (1,), selectors=expressions)
        assert found(plan, "repeated_string_scan") == []

    def test_a_chain_where_every_step_depends_on_the_last_stays_a_chain(self):
        finding = self.chain([("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")])
        assert finding.fix.startswith("keep the chain")

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


class TestPythonUdf:
    def test_a_python_function_in_an_expression_or_over_the_frame(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=1_000)
            .node(2, "Select", (1,), rows=1_000, ms=50, selectors=['col("a").python_udf()'])
            .node(
                3, "InMemoryMap", (2,), rows=1_000, ms=40, blocked_ms=40, format_str="OPAQUE_PYTHON"
            )
        )
        assert [f.node_id for f in found(plan, "python_udf")] == [2, 3]
        assert found(plan, "in_memory_fallback") == []

    def test_native_expressions_stay_quiet(self):
        plan = Plan().node(1, "MultiScan").node(2, "Select", (1,), selectors=['(col("a") + 1)'])
        assert found(plan, "python_udf") == []


class TestDatetimeFormatInferred:
    def test_an_inferred_format_is_reported(self):
        plan = Plan().node(1, "MultiScan", rows=10).node(2, "StrptimeInfer", (1,), format="None")
        (finding,) = found(plan, "datetime_format_inferred")
        assert numbers(finding) == {"rows_in": 10}

    def test_a_given_format_stays_quiet(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=10)
            .node(2, "Select", (1,), selectors=['col("d").str.strptime(["raise"])'])
        )
        assert found(plan, "datetime_format_inferred") == []


class TestRepeatedSubplan:
    def copies(self, n: int, *, shared_below: bool) -> Plan:
        plan = Plan().node(1, "MultiScan", rows=1_000, ms=10)
        if shared_below:
            plan.node(2, "Multiplexer", (1,), rows=1_000 * n)
        for copy in range(n):
            base = 10 * (copy + 1)
            source = (2,) if shared_below else ()
            if not shared_below:
                plan.node(base, "MultiScan", rows=1_000, ms=10, scan_type="parquet")
                source = (base,)
            plan.node(base + 1, "Filter", source, rows=500, ms=20, predicate='(col("a") > 1)')
            plan.node(base + 2, "Select", (base + 1,), rows=500, ms=20, selectors=['col("a")'])
        roots = tuple(10 * (c + 1) + 2 for c in range(n))
        return plan.node(99, "Zip", roots)

    def test_the_same_work_run_three_times(self):
        (finding,) = found(self.copies(3, shared_below=True), "repeated_subplan")
        assert finding.node_id == 12
        assert numbers(finding) == {"copies": 3, "nodes": 2}
        assert finding.title == "Same 2-node subplan runs 3x"
        assert round(finding.impact.cpu_share, 2) == round(80 / 130, 2)

    def test_a_repeat_inside_a_larger_repeat_is_reported_once(self):
        (finding,) = found(self.copies(2, shared_below=False), "repeated_subplan")
        assert numbers(finding) == {"copies": 2, "nodes": 3}

    def test_one_repeated_node_over_a_shared_input_is_not_a_subplan(self):
        plan = (
            Plan()
            .node(1, "MultiScan", rows=10)
            .node(2, "Multiplexer", (1,))
            .node(3, "SimpleProjection", (2,), columns="['a']")
            .node(4, "SimpleProjection", (2,), columns="['a']")
            .node(5, "Zip", (3, 4))
        )
        assert found(plan, "repeated_subplan") == []


class TestRepeatedPluginCall:
    CALL = 'col("v").lib/mylib.so:fold()'

    def test_the_same_call_twice_in_one_node(self):
        plan = Plan().node(1, "MultiScan").node(2, "Select", (1,), selectors=[self.CALL, self.CALL])
        (finding,) = found(plan, "repeated_plugin_call")
        assert numbers(finding) == {"calls": 2, "repeated": 1}

    def test_the_fix_follows_whether_this_polars_shares_plugin_calls(self):
        plan = Plan().node(1, "MultiScan").node(2, "Select", (1,), selectors=[self.CALL, self.CALL])
        older = evaluate(
            plan.query(polars_version="1.44.2"),
            [r for r in RULES if r.id == "repeated_plugin_call"],
        )
        newer = evaluate(
            plan.query(polars_version="2.0.0"), [r for r in RULES if r.id == "repeated_plugin_call"]
        )
        assert older[0].fix.startswith("compute it once")
        assert "`is_deterministic=True`" in newer[0].fix

    def test_different_inputs_stay_quiet(self):
        other = 'col("w").lib/mylib.so:fold()'
        plan = Plan().node(1, "MultiScan").node(2, "Select", (1,), selectors=[self.CALL, other])
        assert found(plan, "repeated_plugin_call") == []
