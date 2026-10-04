"""What an insight rule reports: plain data, safe to export anywhere."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Kind = Literal["problem", "applied"]
Level = Literal["warn", "info", "applied"]

WARN_AT = 0.01
"""A problem touching at least this share of CPU or wall time is a warning;
below, information. Neither is ever dropped."""

SCHEMA = "insights@1"


@dataclass(frozen=True, slots=True)
class Text:
    title: str
    detail: str


@dataclass(frozen=True, slots=True)
class Impact:
    cpu_share: float
    """Share of the query's attributed CPU time the finding touches."""
    blocked_share: float
    """Share of wall time a single blocking step held the pipeline."""

    @property
    def largest(self) -> float:
        return max(self.cpu_share, self.blocked_share)


@dataclass(frozen=True, slots=True)
class Finding:
    """One observation about one node. Text carries numbers and node kinds only."""

    rule: str
    kind: Kind
    level: Level
    node_id: int
    node_kind: str
    impact: Impact
    title: str
    detail: str
    evidence: dict[str, int | float | bool] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "rule": self.rule,
            "kind": self.kind,
            "level": self.level,
            "node_id": self.node_id,
            "node_kind": self.node_kind,
            "cpu_share": round(self.impact.cpu_share, 6),
            "blocked_share": round(self.impact.blocked_share, 6),
            "title": self.title,
            "detail": self.detail,
            "evidence": self.evidence,
        }
