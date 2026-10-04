"""Runs the rules over a query and ranks what they find."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from polars_telemetry.model.insights.finding import WARN_AT, Finding, Level
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
    found = [
        finding
        for rule in rules
        for node in query.plan.values()
        if (finding := _check(rule, node, view)) is not None
    ]
    problems = sorted((f for f in found if f.kind == "problem"), key=lambda f: -f.impact.largest)
    applied = [f for f in found if f.kind == "applied"]
    return (*problems, *applied)


def _check(rule: Rule[Any], node: PlanNode, view: PlanView) -> Finding | None:
    try:
        evidence = rule.check(node, view)
        if evidence is None:
            return None
        impact = rule.impact(node, evidence, view)
        text = rule.describe(evidence)
        numbers = rule.numbers(evidence)
    except Exception:
        if rule.id not in _failed:
            _failed.add(rule.id)
            _logger.warning("polars-telemetry: insight rule %s failed", rule.id, exc_info=True)
        return None
    level: Level = (
        "applied" if rule.kind == "applied" else "warn" if impact.largest >= WARN_AT else "info"
    )
    return Finding(
        rule.id, rule.kind, level, node.node_id, node.kind, impact, text.title, text.detail, numbers
    )
