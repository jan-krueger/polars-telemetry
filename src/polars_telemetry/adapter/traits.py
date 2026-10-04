"""How a node executes, read from polars' node kinds and expression text.

The only place that parses polars' expression text. Insight rules read the
`NodeTraits` it returns, so a change in polars' text format is fixed here and
caught by the contract tests, not in every rule. Column names leave this module
only as opaque tokens.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections import Counter
from dataclasses import replace
from typing import TYPE_CHECKING

from polars_telemetry.adapter.dialect import (
    DEDUPLICATING,
    GROUPING,
    IN_MEMORY_FALLBACK,
    INFERS_DATETIME_FORMAT,
    PYTHON_FORMAT,
)
from polars_telemetry.model.redaction import PLUGIN_PATH
from polars_telemetry.model.types import CallCount, NodeTraits

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping

    from polars_telemetry.model.types import PlanNode

_logger = logging.getLogger("polars_telemetry")

_COLUMN = re.compile(r'col\("((?:[^"\\]|\\.)*)"\)')
_NAME = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
_PYTHON_UDF = re.compile(r"\.python_udf\(")
_KEEPS_VALUE = frozenset({"first", "last", "alias"})
_UNIQUE = re.compile(r"\.unique\(")


def with_traits(plan: dict[int, PlanNode]) -> dict[int, PlanNode]:
    """The plan with each node's traits read; a node polars wrote unexpectedly keeps none."""
    read: dict[int, PlanNode] = {}
    for node_id, node in plan.items():
        try:
            read[node_id] = replace(node, traits=traits(node.kind, node.properties))
        except Exception:
            _logger.debug("polars-telemetry: no traits for a %s node", node.kind, exc_info=True)
            read[node_id] = node
    return read


def traits(kind: str, properties: Mapping[str, object]) -> NodeTraits:
    """The neutral facts insight rules need about one node."""
    texts = [text for text in _texts(properties) if "(" in text]
    strings: Counter[tuple[str, str]] = Counter()
    plugins: Counter[tuple[str, str]] = Counter()
    for text in texts:
        for column, steps in _chains(text):
            target = token(column)
            for step, call in steps:
                if step.startswith("plugin:"):
                    plugins[(step.removeprefix("plugin:"), token(call))] += 1
                elif step.startswith("str."):
                    strings[(step.removeprefix("str."), target)] += 1
    return NodeTraits(
        in_memory_fallback=kind in IN_MEMORY_FALLBACK,
        infers_datetime_format=kind == INFERS_DATETIME_FORMAT,
        python_udf=properties.get("name") == "python_udf"
        or properties.get("format_str") == PYTHON_FORMAT
        or any(_PYTHON_UDF.search(text) for text in texts),
        deduplicates=kind in DEDUPLICATING or (kind in GROUPING and _only_picks(properties)),
        asks_unique=any(_UNIQUE.search(text) for text in texts),
        string_calls=_counts(strings),
        plugin_calls=_counts(plugins),
    )


def _only_picks(properties: Mapping[str, object]) -> bool:
    """Every aggregation keeps one value of a column as it is, or there are none."""
    aggregations = list(_texts(properties.get("aggs_per_input", properties.get("aggs", []))))
    for expression in aggregations:
        chains = list(_chains(expression))
        if len(chains) != 1 or not {name for name, _ in chains[0][1]} <= _KEEPS_VALUE:
            return False
        if not expression.startswith("col("):
            return False
    return True


def token(column: str) -> str:
    """A stable stand-in for a column name that reveals nothing about it."""
    return hashlib.blake2b(column.encode(), digest_size=4).hexdigest()


def _counts(counter: Counter[tuple[str, str]]) -> tuple[CallCount, ...]:
    return tuple(
        CallCount(function, target, count) for (function, target), count in sorted(counter.items())
    )


def _texts(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _texts(item)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from _texts(item)


def _chains(text: str) -> Iterator[tuple[str, list[tuple[str, str]]]]:
    """Each `col("…")` with the methods called on it, in order, and the chain up to each."""
    for match in _COLUMN.finditer(text):
        steps: list[tuple[str, str]] = []
        position = match.end()
        while position < len(text) and text[position] == ".":
            rest = position + 1
            plugin = PLUGIN_PATH.match(text, rest)
            if plugin:
                name, position = (
                    f"plugin:{plugin['symbol']}",
                    plugin.end() + 1 + len(plugin["symbol"]),
                )
            else:
                called = _NAME.match(text, rest)
                if not called:
                    break
                name, position = called.group(0), called.end()
            if position >= len(text) or text[position] != "(":
                break
            position = _after_arguments(text, position)
            steps.append((name, text[match.start() : position]))
        yield match.group(1), steps


def _after_arguments(text: str, opening: int) -> int:
    """The index just past the parenthesis that closes the one at `opening`."""
    depth, position, quoted = 0, opening, False
    while position < len(text):
        char = text[position]
        if quoted:
            if char == "\\":
                position += 1
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return position + 1
        position += 1
    return len(text)
