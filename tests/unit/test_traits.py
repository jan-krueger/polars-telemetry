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
        'col("name").str.replace(["a"], ["b"]).str.replace(["c"], ["d"]).alias("x")',
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
def test_plugin_calls_are_counted_per_input_wherever_the_plugin_lives(path):
    expression = f'col("v").fill_null(["x"]).{path}:fold().alias("w")'
    assert calls("Select", expression, expression, field="plugin_calls") == {
        ("fold", token("v")): 2
    }


def test_execution_facts_come_from_the_node_kind():
    assert traits("InMemoryMap", {}).in_memory_fallback
    assert traits("ColumnarFunction", {"name": "rank"}).in_memory_fallback
    assert traits("StrptimeInfer", {}).infers_datetime_format
    assert traits("ColumnarFunction", {"name": "python_udf"}).python_udf
    assert traits("Select", {"selectors": ['col("a").python_udf()']}).python_udf
    assert traits("Select", {}) == traits("Filter", {})
