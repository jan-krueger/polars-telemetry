"""Runs the rules over a query and ranks what they find."""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from polars_telemetry.model.insights.finding import WARN_AT, Finding, Impact, Level
from polars_telemetry.model.insights.view import PlanView

if TYPE_CHECKING:
    from collections.abc import Sequence

    from polars_telemetry.model.insights.rule import Rule
    from polars_telemetry.model.types import PlanNode, Query

_logger = logging.getLogger("polars_telemetry")
_failed: set[str] = set()


def evaluate(query: Query, rules: Sequence[Rule[Any]] | None = None) -> tuple[Finding, ...]:
    """Every finding for `query`: problems by impact, then what polars already did well."""
    if rules is None:
        from polars_telemetry.model.insights.rules import RULES

        rules = RULES
    if not query.plan:
        return ()
    view = PlanView(query)
    found = _grouped(
        [
            finding
            for rule in rules
            for node in query.plan.values()
            if (finding := _check(rule, node, view)) is not None
        ]
    )
    problems = sorted((f for f in found if f.kind == "problem"), key=lambda f: -f.impact.largest)
    applied = [f for f in found if f.kind == "applied"]
    return (*problems, *applied)


def _grouped(found: list[Finding]) -> list[Finding]:
    """One finding for the same finding on several nodes, its impact their sum.

    A query that repeats a step hundreds of times gets that many identical
    findings, each too small to warn about, while together they can cover
    most of the query.
    """
    groups: dict[tuple[str, str, str, str], list[Finding]] = {}
    for finding in found:
        groups.setdefault((finding.rule, finding.node_kind, finding.title, finding.fix), []).append(
            finding
        )
    return [members[0] if len(members) == 1 else _merged(members) for members in groups.values()]


def _merged(members: list[Finding]) -> Finding:
    heaviest = max(members, key=lambda f: f.impact.largest)
    impact = Impact(
        min(1.0, sum(f.impact.cpu_share for f in members)),
        min(1.0, sum(f.impact.blocked_share for f in members)),
    )
    level: Level = (
        "applied" if heaviest.kind == "applied" else "warn" if impact.largest >= WARN_AT else "info"
    )
    return replace(
        heaviest,
        level=level,
        impact=impact,
        title=f"{heaviest.title} ({len(members)} nodes)",
        node_ids=tuple(sorted(f.node_id for f in members)),
    )


def _check(rule: Rule[Any], node: PlanNode, view: PlanView) -> Finding | None:
    try:
        evidence = rule.check(node, view)
        if evidence is None:
            return None
        impact = rule.impact(node, evidence, view)
        text = rule.describe(evidence)
        measures = rule.measures(evidence)
    except Exception:
        if rule.id not in _failed:
            _failed.add(rule.id)
            _logger.warning("polars-telemetry: insight rule %s failed", rule.id, exc_info=True)
        return None
    level: Level = (
        "applied" if rule.kind == "applied" else "warn" if impact.largest >= WARN_AT else "info"
    )
    return Finding(
        rule.id, rule.kind, level, node.node_id, node.kind, impact, text.title, text.fix, measures
    )
