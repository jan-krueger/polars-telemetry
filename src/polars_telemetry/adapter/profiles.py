"""Profile documents read back into the model, the inverse of `build_profile`.

Nodes go through `build_plan` like a live query's, so roles, facets and traits
are today's even for a profile an older version wrote.
"""

from __future__ import annotations

import gzip
import json
import math
import zlib
from dataclasses import dataclass, fields
from typing import TYPE_CHECKING, Any
from uuid import UUID

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.adapter.traits import with_traits
from polars_telemetry.model.diagnostics import Diagnostics
from polars_telemetry.model.insights import Finding
from polars_telemetry.model.insights.finding import SCHEMA as INSIGHTS_SCHEMA
from polars_telemetry.model.types import CallSite, PlanNode, Query

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping
    from pathlib import Path

SCHEMA_PREFIX = "polars-telemetry/profile@1"
EVENTS_PREFIX = "polars-telemetry/events@"
_GZIP_MAGIC = b"\x1f\x8b"
_INT_LIMIT = 2**63
_DEPTH_LIMIT = 64
_TOO_DEEP = f"nested more than {_DEPTH_LIMIT} levels deep"


class ProfileError(ValueError):
    """A document that is not a profile this version can read."""


@dataclass(frozen=True, slots=True)
class Skipped:
    """A line of a session file that held no readable profile."""

    line: int
    reason: str


@dataclass(frozen=True, slots=True)
class Line:
    """One line of a session file, as read and as written."""

    number: int
    raw: bytes
    document: dict[str, Any] | None
    read: Query | Skipped | None
    """None for a line that holds no profile and is no damage either, such as an event."""


def read_profile(document: object) -> Query:
    """One profile document as the Query it was written from."""
    if not isinstance(document, dict):
        raise ProfileError(f"not a JSON object but {_kind(document)}")
    schema = document.get("schema")
    if not isinstance(schema, str) or not schema.startswith(SCHEMA_PREFIX):
        raise ProfileError(f"not a profile@1 document (schema {schema!r})")
    plan = document.get("plan") or {}
    if not isinstance(plan, dict):
        raise ProfileError(f"plan is {_kind(plan)}, not an object")
    physical = _nodes(plan, "physical")
    logical = _nodes(plan, "logical")
    version = _text(document.get("polars_version"))
    if "query_id" not in document:
        raise ProfileError("no query_id")
    try:
        query_id = UUID(str(document["query_id"]))
    except ValueError:
        raise ProfileError(f"query_id {document['query_id']!r} is not a UUID") from None
    return Query(
        query_id=query_id,
        wall_ms=_number(document.get("wall_ms")) or 0.0,
        plan=with_traits(_plan(physical, "physical"), version),
        logical=with_traits(_plan(logical, "logical"), version),
        metrics=build_metrics(
            [
                {"phys_node_key": node["id"], **_counters(node["metrics"])}
                for node in physical
                if isinstance(node.get("metrics"), dict) and node["metrics"]
            ]
        ),
        call_site=_call_site(document.get("call_site")),
        label=_text(document.get("label")) or None,
        engine="streaming" if physical else None,
        polars_version=version,
        fingerprint=_text(document.get("fingerprint")),
        diagnostics=_diagnostics(document.get("diagnostics")),
        failed=document["failed"] if isinstance(document.get("failed"), str) else None,
        started_unix_ns=_count(document.get("started_unix_ns")) or 0,
        insights=_insights(document.get("insights")),
        planning_ms=_number(document.get("planning_ms")),
        telemetry_ms=_number(document.get("telemetry_ms")),
        query_metrics=_query_metrics(document.get("query_metrics")),
    )


def _query_metrics(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    return {str(key): number for key, v in value.items() if (number := _count(v)) is not None}


def read_profiles(path: Path) -> Iterator[Query | Skipped]:
    """Every profile in a session file or an event recording, one JSON document per line."""
    for line in read_lines(path):
        if line.read is not None:
            yield line.read


def read_lines(path: Path) -> Iterator[Line]:
    """Every line of a session file, plain or gzip, with what it reads as.

    Raises OSError only when the file cannot be opened; damage inside it is a Skipped line.
    """
    with path.open("rb") as file:
        compressed = file.read(2) == _GZIP_MAGIC
    number = 0
    try:
        with gzip.open(path) if compressed else path.open("rb") as lines:
            for number, raw in enumerate(lines, start=1):
                yield _line(number, raw.rstrip(b"\r\n"))
    except (OSError, EOFError, zlib.error):
        if not compressed:
            raise
        yield Line(number + 1, b"", None, Skipped(number + 1, "the gzip data ends or breaks here"))


def _line(number: int, raw: bytes) -> Line:
    try:
        text = raw.decode("utf-8-sig" if number == 1 else "utf-8")
    except UnicodeDecodeError:
        return Line(number, raw, None, Skipped(number, "not UTF-8 text"))
    if not text.strip():
        return Line(number, raw, None, None)
    try:
        document = json.loads(text)
    except RecursionError:
        return Line(number, raw, None, Skipped(number, _TOO_DEEP))
    except ValueError as exc:
        return Line(number, raw, None, Skipped(number, f"not valid JSON ({exc})"))
    if _deeper_than(document, _DEPTH_LIMIT):
        return Line(number, raw, None, Skipped(number, _TOO_DEEP))
    profile = document
    if isinstance(document, dict) and str(document.get("schema", "")).startswith(EVENTS_PREFIX):
        if document.get("type") != "query.finished":
            return Line(number, raw, None, None)
        profile = document.get("profile")
    try:
        read: Query | Skipped = read_profile(profile)
    except Exception as exc:
        read = Skipped(number, _reason(exc))
    return Line(number, raw, document if isinstance(document, dict) else None, read)


def _deeper_than(value: object, limit: int) -> bool:
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        if not isinstance(item, dict | list):
            continue
        if depth >= limit:
            return True
        stack.extend(
            (child, depth + 1) for child in (item.values() if isinstance(item, dict) else item)
        )
    return False


def _reason(exc: Exception) -> str:
    if isinstance(exc, ProfileError):
        return str(exc)
    if isinstance(exc, RecursionError):
        return _TOO_DEEP
    return f"unreadable ({type(exc).__name__}: {exc})" if str(exc) else type(exc).__name__


def _kind(value: object) -> str:
    if value is None:
        return "null"
    name = {"dict": "object", "list": "list", "str": "string", "bool": "boolean"}.get(
        type(value).__name__, "number"
    )
    return f"an {name}" if name[0] in "aeiou" else f"a {name}"


def _nodes(plan: dict[str, Any], side: str) -> list[dict[str, Any]]:
    nodes = plan.get(side) or []
    if not isinstance(nodes, list):
        raise ProfileError(f"plan.{side} is {_kind(nodes)}, not a list")
    for node in nodes:
        if not isinstance(node, dict):
            raise ProfileError(f"plan.{side} has an entry that is {_kind(node)}, not a node")
        if _count(node.get("id")) is None:
            raise ProfileError(f"plan.{side} has a node without an integer id")
    return nodes


def _plan(nodes: list[dict[str, Any]], side: str) -> dict[int, PlanNode]:
    plan = build_plan([_record(node) for node in nodes])
    if _has_cycle(plan):
        raise ProfileError(f"plan.{side} has a cycle")
    return plan


def _has_cycle(plan: Mapping[int, PlanNode]) -> bool:
    waiting = {node_id: sum(i in plan for i in node.inputs) for node_id, node in plan.items()}
    consumers: dict[int, list[int]] = {}
    for node_id, node in plan.items():
        for i in node.inputs:
            if i in plan:
                consumers.setdefault(i, []).append(node_id)
    ready = [node_id for node_id, count in waiting.items() if count == 0]
    done = 0
    while ready:
        node_id = ready.pop()
        done += 1
        for consumer in consumers.get(node_id, ()):
            waiting[consumer] -= 1
            if waiting[consumer] == 0:
                ready.append(consumer)
    return done < len(plan)


def _record(node: Mapping[str, Any]) -> dict[str, Any]:
    properties = dict(node["properties"]) if isinstance(node.get("properties"), dict) else {}
    properties.setdefault("type", _text(node.get("kind")) or "Unknown")
    inputs = node.get("inputs")
    return {
        "id": node["id"],
        "input_ids": [i for i in inputs if _count(i) is not None]
        if isinstance(inputs, list)
        else [],
        "properties": properties,
    }


def _counters(metrics: Mapping[str, Any]) -> dict[str, Any]:
    kept: dict[str, Any] = {
        key: value for key, value in metrics.items() if _count(value) is not None
    }
    if isinstance(metrics.get("done"), bool):
        kept["done"] = metrics["done"]
    if isinstance(metrics.get("custom"), list):
        kept["custom"] = metrics["custom"]
    return kept


def _insights(written: object) -> tuple[Finding, ...] | None:
    """Findings as written, when a version that reads them wrote them."""
    if not isinstance(written, dict) or written.get("schema") != INSIGHTS_SCHEMA:
        return None
    findings = written.get("findings") or []
    try:
        return tuple(Finding.from_dict(f) for f in findings)
    except Exception:
        return None


def _call_site(site: object) -> CallSite | None:
    if not isinstance(site, dict):
        return None
    filepath, lineno, function = (
        site.get("filepath"),
        _count(site.get("lineno")),
        site.get("function"),
    )
    if not isinstance(filepath, str) or lineno is None or not isinstance(function, str):
        return None
    return CallSite(filepath, lineno, function)


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _count(value: object) -> int | None:
    """An integer a counter can hold; anything else is damage."""
    if isinstance(value, int) and not isinstance(value, bool) and -_INT_LIMIT < value < _INT_LIMIT:
        return value
    return None


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _diagnostics(values: object) -> Diagnostics:
    if not isinstance(values, dict):
        return Diagnostics()
    known = {f.name for f in fields(Diagnostics)}
    return Diagnostics(
        **{
            name: value
            for name, value in values.items()
            if name in known
            and (isinstance(value, bool) or _count(value) is not None or _number(value) is not None)
        }
    )
