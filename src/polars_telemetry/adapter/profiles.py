"""Profile documents read back into the model, the inverse of `build_profile`.

Nodes go through `build_plan` like a live query's, so roles, facets and traits
are today's even for a profile an older version wrote.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, fields
from typing import TYPE_CHECKING, Any
from uuid import UUID

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.adapter.traits import with_traits
from polars_telemetry.model.diagnostics import Diagnostics
from polars_telemetry.model.insights import Finding
from polars_telemetry.model.insights.finding import SCHEMA as INSIGHTS_SCHEMA
from polars_telemetry.model.types import CallSite, Query

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping
    from pathlib import Path

SCHEMA_PREFIX = "polars-telemetry/profile@1"


class ProfileError(ValueError):
    """A document that is not a profile this version can read."""


@dataclass(frozen=True, slots=True)
class Skipped:
    """A line of a session file that held no readable profile."""

    line: int
    reason: str


def read_profile(document: Mapping[str, Any]) -> Query:
    """One profile document as the Query it was written from."""
    schema = document.get("schema")
    if not isinstance(schema, str) or not schema.startswith(SCHEMA_PREFIX):
        raise ProfileError(f"not a profile@1 document (schema {schema!r})")
    plan = document.get("plan") or {}
    physical = list(plan.get("physical") or [])
    site = document.get("call_site")
    return Query(
        query_id=UUID(str(document["query_id"])),
        wall_ms=float(document.get("wall_ms") or 0.0),
        plan=with_traits(build_plan([_record(node) for node in physical])),
        logical=with_traits(build_plan([_record(node) for node in plan.get("logical") or []])),
        metrics=build_metrics(
            [
                {"phys_node_key": node["id"], **node["metrics"]}
                for node in physical
                if node.get("metrics")
            ]
        ),
        call_site=None
        if not site
        else CallSite(site["filepath"], site["lineno"], site["function"]),
        label=document.get("label"),
        engine="streaming" if physical else None,
        polars_version=str(document.get("polars_version") or ""),
        fingerprint=str(document.get("fingerprint") or ""),
        diagnostics=_diagnostics(document.get("diagnostics") or {}),
        failed=document.get("failed"),
        started_unix_ns=int(document.get("started_unix_ns") or 0),
        insights=_insights(document.get("insights")),
    )


def read_profiles(path: Path) -> Iterator[Query | Skipped]:
    """Every profile in a session file, one JSON document per line."""
    with path.open(encoding="utf-8") as lines:
        for number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                yield read_profile(json.loads(line))
            except (ValueError, KeyError, TypeError) as exc:
                yield Skipped(number, str(exc) or type(exc).__name__)


def _record(node: Mapping[str, Any]) -> dict[str, Any]:
    properties = dict(node.get("properties") or {})
    properties.setdefault("type", node.get("kind", "Unknown"))
    return {"id": node["id"], "input_ids": list(node.get("inputs") or []), "properties": properties}


def _insights(written: object) -> tuple[Finding, ...] | None:
    """Findings as written, when a version that reads them wrote them."""
    if not isinstance(written, dict) or written.get("schema") != INSIGHTS_SCHEMA:
        return None
    return tuple(Finding.from_dict(f) for f in written.get("findings") or [])


def _diagnostics(values: Mapping[str, Any]) -> Diagnostics:
    known = {f.name for f in fields(Diagnostics)}
    return Diagnostics(**{name: value for name, value in values.items() if name in known})
