"""What an insight rule reports: plain data, safe to export anywhere."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

Kind = Literal["problem", "applied"]
Level = Literal["warn", "info", "applied"]
Unit = Literal["rows", "count", "ms", "share", "ratio"]
UNITS: tuple[Unit, ...] = ("rows", "count", "ms", "share", "ratio")

WARN_AT = 0.01
"""A problem touching at least this share of CPU or wall time is a warning;
below, information. Neither is ever dropped."""

SCHEMA = "insights@1"


def share(fraction: float) -> str:
    """A fraction as a percentage with two significant digits: 0.0016%, 2.5%, 46%."""
    percent = fraction * 100
    if percent == 0:
        return "0%"
    rounded = Decimal(f"{percent:.2g}")
    return f"{rounded:.0f}%" if rounded >= 10 else f"{rounded:f}%"


def duration(ms: float) -> str:
    """Milliseconds as a reader would say them: 40 ms, 3.6 s, 7.6 min."""
    if ms < 1_000:
        return f"{ms:,.0f} ms"
    if ms < 60_000:
        return f"{ms / 1_000:,.1f} s"
    return f"{ms / 60_000:,.1f} min"


def count(n: float) -> str:
    """A count as a reader would say it: 940, 12,345, 301K, 12.4M."""
    if abs(n) < 100_000:
        return f"{n:,.0f}"
    for divisor, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(n) >= divisor:
            return f"{n / divisor:.3g}{suffix}"
    return f"{n:,.0f}"


def measured(value: float, unit: Unit) -> str:
    if unit == "ms":
        return duration(value)
    if unit == "share":
        return share(value)
    if unit == "ratio":
        return f"{value:.3g}x"
    return count(value)


def unit(kind: Unit) -> Any:
    """A field of a rule's evidence that the finding reports, in this unit."""
    return field(metadata={"unit": kind})


@dataclass(frozen=True, slots=True)
class Text:
    title: str
    fix: str


@dataclass(frozen=True, slots=True)
class Measure:
    name: str
    value: float
    unit: Unit

    def __str__(self) -> str:
        return f"{self.name} {measured(self.value, self.unit)}"

    @classmethod
    def from_dict(cls, values: dict[str, Any]) -> Measure:
        kind = values.get("unit")
        return cls(str(values["name"]), float(values["value"]), kind if kind in UNITS else "count")

    def to_dict(self) -> dict[str, object]:
        return {"name": self.name, "value": self.value, "unit": self.unit}


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
    """One observation about one node. Text carries numbers, node kinds and API names only."""

    rule: str
    kind: Kind
    level: Level
    node_id: int
    node_kind: str
    impact: Impact
    title: str
    fix: str
    evidence: tuple[Measure, ...] = ()

    @classmethod
    def from_dict(cls, values: dict[str, Any]) -> Finding:
        return cls(
            rule=str(values["rule"]),
            kind=values["kind"],
            level=values["level"],
            node_id=int(values["node_id"]),
            node_kind=str(values["node_kind"]),
            impact=Impact(float(values["cpu_share"]), float(values["blocked_share"])),
            title=str(values["title"]),
            fix=str(values.get("fix") or ""),
            evidence=tuple(Measure.from_dict(m) for m in values.get("evidence") or []),
        )

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
            "fix": self.fix,
            "evidence": [m.to_dict() for m in self.evidence],
        }
