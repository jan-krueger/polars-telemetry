"""Masking what a query reveals about your data.

A `Redaction` says what to mask. `redact_query` applies it to a whole `Query`
before a receiver that asked for it sees anything, so no exporter, including
one an application wrote, has to remember to.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import PlanNode, Query


@dataclass(frozen=True)
class Redaction:
    """What to mask before a query reaches an exporter.

    The default masks literal values: text, numbers, and dates and times.
    Column names, operators and the plan's shape are always kept, so a masked
    query still shows which filter was slow.

    Examples:
        >>> Redaction()  # literal values
        >>> Redaction(numbers=False)  # keep numbers, mask the rest
        >>> Redaction(paths=True, call_site=True, labels=True)  # as little as possible
    """

    strings: bool = True
    """Quoted text such as `"Brand#12"` becomes `"<str>"`. Column and alias
    names are kept."""

    numbers: bool = True
    """Numbers such as `60.0` or `1.0000e-9` become `<num>`."""

    temporal: bool = True
    """Dates, datetimes, times and durations become `<date>`, `<datetime>`,
    `<time>` and `<duration>`."""

    paths: bool = False
    """File paths that are scanned or written become `<path>`, and so does a
    plugin's library path in an expression."""

    call_site: bool = False
    """Drop the file, line and function that ran the query."""

    labels: bool = False
    """Drop labels set with `label()`."""

    custom: Callable[[str], str] | None = None
    """Your own rule, applied to every expression and error message after the
    masks above."""

    @property
    def masks(self) -> tuple[str, ...]:
        """What this masks, by field name, for a reader to show."""
        chosen = tuple(name for name in _SWITCHES if getattr(self, name))
        return (*chosen, "custom") if self.custom is not None else chosen


LITERALS = Redaction()

_SWITCHES = ("strings", "numbers", "temporal", "paths", "call_site", "labels")


def strictest(*redactions: Redaction | None) -> Redaction | None:
    """A redaction masking everything any of `redactions` masks."""
    given = [r for r in redactions if r is not None]
    if len(set(given)) <= 1:
        return given[0] if given else None
    rules = [r.custom for r in given if r.custom is not None]

    def every_rule(text: str) -> str:
        for rule in rules:
            text = rule(text)
        return text

    return Redaction(
        **{switch: any(getattr(r, switch) for r in given) for switch in _SWITCHES},
        custom=every_rule if rules else None,
    )


# Where a literal may end: not inside a word, and not before more digits. A
# dot before a letter is a method call on the literal, as in `1.5.alias("x")`.
_END = r"(?!\w)(?!\.\d)"
_START = r"(?<![\w.])"

# polars prints string literals raw, without escaping quotes or backslashes,
# so a literal ends only at a quote that something a literal can precede
# follows. A literal with no such end runs to the end of the text.
_STRING_END = re.compile(r'"(?=$|[)\],.]| [&|=!<>+\-*/%])')

# Longest form first, so a date is never read as three numbers.
_TOKEN = re.compile(
    rf"(?P<datetime>{_START}\d{{4}}-\d{{2}}-\d{{2}}[ T]\d{{2}}:\d{{2}}(?::\d{{2}}(?:\.\d+)?)?"
    rf"(?:Z|[+-]\d{{2}}:?\d{{2}})?{_END})"
    rf"|(?P<date>{_START}\d{{4}}-\d{{2}}-\d{{2}}{_END})"
    rf"|(?P<time>(?<![\w.:])\d{{2}}:\d{{2}}:\d{{2}}(?:\.\d+)?{_END})"
    rf"|(?P<duration>{_START}(?:\d+(?:ns|us|µs|ms|mo|s|m|h|d|w|q|y))+{_END})"
    rf"|(?P<num>{_START}\d+(?:\.\d+)?(?:[eE][+-]?\d+)?{_END})"
)

# Quoted text directly after these is a column or alias name, not user data.
_NAME_CONTEXT = re.compile(r"(?:col|alias|name|nth|field|prefix|suffix)\($")

# A plugin function in expression text: a method dot, its shared library's path,
# absolute or relative to the environment, then `:name(`.
PLUGIN_PATH = re.compile(
    r'(?<=\.)(?:[A-Za-z]:)?(?:[^\s"():\\/]*[\\/])+(?P<library>[^\s"():\\/.]+)'
    r'[^\s"():\\/]*\.(?:so|dylib|dll|pyd)(?=:(?P<symbol>[A-Za-z_]\w*))'
)


def plugin_libraries(text: str) -> str:
    """Expression text with each plugin's library path reduced to the library's name."""
    return PLUGIN_PATH.sub(lambda match: match["library"], text)


# Plan properties holding a file path rather than an expression.
_PATH_KEYS = frozenset({"first_source", "dest", "target", "path", "paths", "sources"})


def redact(text: str, redaction: Redaction = LITERALS) -> str:
    """Mask literal values in one plan expression or error message.

    Works on polars' text form of expressions, so it is a precaution rather
    than a guarantee. Idempotent unless `custom` is not.
    """

    def mask(match: re.Match[str]) -> str:
        kind, value = match.lastgroup, match.group(0)
        if kind == "num":
            return "<num>" if redaction.numbers else value
        return f"<{kind}>" if redaction.temporal else value

    def unquoted(segment: str) -> str:
        if redaction.paths:
            segment = PLUGIN_PATH.sub("<path>", segment)
        return _TOKEN.sub(mask, segment)

    parts, last = [], 0
    for start, end in _quoted(text):
        parts.append(unquoted(text[last:start]))
        named = _NAME_CONTEXT.search(text[max(0, start - 8) : start])
        parts.append('"<str>"' if redaction.strings and not named else text[start:end])
        last = end
    parts.append(unquoted(text[last:]))
    masked = "".join(parts)
    return redaction.custom(masked) if redaction.custom is not None else masked


def _quoted(text: str) -> list[tuple[int, int]]:
    spans, position = [], 0
    while (start := text.find('"', position)) != -1:
        end = _STRING_END.search(text, start + 1)
        stop = end.end() if end else len(text)
        spans.append((start, stop))
        position = stop
    return spans


def _path_text(value: str, redaction: Redaction) -> str:
    # "Memory" is a sink's destination too, and is no path.
    return "<path>" if redaction.paths and any(c in value for c in "/\\.") else value


def _path(value: object, redaction: Redaction) -> object:
    if isinstance(value, list):
        return [_path(item, redaction) for item in value]
    if isinstance(value, dict):
        return {key: _path(item, redaction) for key, item in value.items()}
    return _path_text(value, redaction) if isinstance(value, str) else value


def _walk(value: object, redaction: Redaction) -> object:
    if isinstance(value, str):
        return redact(value, redaction)
    if isinstance(value, list):
        return [_walk(item, redaction) for item in value]
    if isinstance(value, dict):
        return {key: _walk(item, redaction) for key, item in value.items()}
    return value


def _strings(values: tuple[str, ...], redaction: Redaction) -> tuple[str, ...]:
    return tuple(redact(value, redaction) for value in values)


def _node(node: PlanNode, redaction: Redaction) -> PlanNode:
    properties = {
        key: _path(value, redaction) if key in _PATH_KEYS else _walk(value, redaction)
        for key, value in node.properties.items()
    }
    changes: dict[str, object] = {"properties": properties}
    if node.scan is not None:
        source = node.scan.source
        changes["scan"] = replace(
            node.scan,
            source=_path_text(source, redaction) if source is not None else None,
            predicates=_strings(node.scan.predicates, redaction),
        )
    if node.join is not None:
        changes["join"] = replace(node.join, left_keys=_strings(node.join.left_keys, redaction))
    if node.sort is not None:
        changes["sort"] = replace(node.sort, columns=_strings(node.sort.columns, redaction))
    if node.aggregation is not None:
        changes["aggregation"] = replace(
            node.aggregation, keys=_strings(node.aggregation.keys, redaction)
        )
    return replace(node, **changes)  # type: ignore[arg-type]


def redact_query(query: Query, redaction: Redaction = LITERALS) -> Query:
    """The same query with what `redaction` names masked or dropped.

    A query already masked by the same redaction comes back as it is.
    """
    if query.redaction == redaction:
        return query
    return replace(
        query,
        plan={node_id: _node(node, redaction) for node_id, node in query.plan.items()},
        logical={node_id: _node(node, redaction) for node_id, node in query.logical.items()},
        failed=redact(query.failed, redaction) if query.failed is not None else None,
        call_site=None if redaction.call_site else query.call_site,
        label=None if redaction.labels else query.label,
        redaction=redaction,
    )
