"""Every insight rule, in one explicit list."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from polars_telemetry.model.insights.rule import Rule

RULES: tuple[Rule[Any], ...] = ()
