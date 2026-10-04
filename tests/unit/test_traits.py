"""Facts about how a node executes, read from polars' kinds and expression text."""

from __future__ import annotations

import pytest

from polars_telemetry.adapter.traits import token, traits


def calls(kind: str, *expressions: str, field: str = "string_calls") -> dict[tuple[str, str], int]:
    found = getattr(traits(kind, {"selectors": list(expressions)}), field)
    return {(c.function, c.target): c.count for c in found}


def test_counts_each_string_function_per_column_across_chains():
    found = calls(
        "Select",
        'col("name").str.replace(["a", "b"]).str.replace(["c", "d"]).alias("x")',
        'col("name").str.contains(["e"]) | col("other").str.contains(["f"])',
    )
    assert found == {
        ("replace", token("name")): 2,
        ("contains", token("name")): 1,
        ("contains", token("other")): 1,
    }


@pytest.mark.parametrize(
    "expression",
    [
        'col("a\\"b").str.contains(["x"])',
        'col("a").str.contains(["(?i)x)"])',
        'col("a").cast(String).fill_null(["?"]).str.to_lowercase()',
    ],
)
def test_quotes_and_parentheses_inside_arguments_do_not_end_the_chain(expression):
    assert sum(calls("Select", expression).values()) == 1


def test_a_column_name_never_leaves_as_text():
    found = traits("Select", {"selectors": ['col("customer_email").str.contains(["x"])']})
    assert "customer_email" not in repr(found)


@pytest.mark.parametrize(
    "path",
    [
        "/opt/app/plugins/mypkg/mypkg.cpython-311-aarch64-linux-gnu.so",
        "lib/python3.12/site-packages/mypkg/mypkg.abi3.so",
        "C:\\envs\\lib\\mypkg\\mypkg.pyd",
    ],
)
def test_identical_plugin_calls_are_counted_wherever_the_plugin_lives(path):
    expression = f'col("v").fill_null(["x"]).{path}:fold().alias("w")'
    other = f'col("v").{path}:fold().alias("u")'
    found = calls("Select", expression, expression, other, field="plugin_calls")
    assert sorted(found.values()) == [1, 2]
    assert {function for function, _ in found} == {"fold"}


def test_execution_facts_come_from_the_node_kind():
    assert traits("InMemoryMap", {}).in_memory_fallback
    assert traits("ColumnarFunction", {"name": "rank"}).in_memory_fallback
    assert traits("StrptimeInfer", {}).infers_datetime_format
    assert traits("ColumnarFunction", {"name": "python_udf"}).python_udf
    assert traits("Select", {"selectors": ['col("a").python_udf()']}).python_udf
    assert traits("InMemoryMap", {"format_str": "OPAQUE_PYTHON"}).python_udf
    assert traits("Select", {}) == traits("Filter", {})


def test_a_node_that_only_removes_duplicates():
    pick = {"aggs_per_input": [['col("a").first().alias("a")', 'col("b").last().alias("b")']]}
    assert traits("GroupBy", pick).deduplicates
    assert traits("GroupBy", {"aggs_per_input": [[]]}).deduplicates
    assert traits("Distinct", {}).deduplicates
    assert not traits("GroupBy", {"aggs_per_input": [['col("a").sum().alias("a")']]}).deduplicates
    assert not traits("GroupBy", {"aggs_per_input": [['len().alias("n")']]}).deduplicates
    assert not traits("Select", pick).deduplicates


def test_an_expression_asking_for_unique_values():
    assert traits("Select", {"exprs": ['col("k").unique()']}).asks_unique
    assert not traits("Select", {"exprs": ['col("k").n_unique()']}).asks_unique


def test_a_replace_chain_reports_how_far_it_merges_and_never_its_literals():
    chain = "".join(
        f'.str.replace(["{p}", "{r}"])'
        for p, r in [("straße", "str."), ("ß", "ss"), ("ü", "ue"), (" ", ""), ("-", "")]
    )
    found = traits("Select", {"selectors": [f'col("street").str.to_lowercase(){chain}']})
    assert [(r.calls, r.groups) for r in found.replace_runs] == [(5, 2)]
    assert "straße" not in repr(found)


def test_a_chain_with_an_expression_argument_merges_unknown():
    text = 'col("s").str.replace(["a", "b"]).str.replace([col("p"), "x"])'
    (run,) = traits("Select", {"selectors": [text]}).replace_runs
    assert run.groups is None
