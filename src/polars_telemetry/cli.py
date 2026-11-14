"""The `polars-telemetry` command."""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING, Any, TextIO

from polars_telemetry.adapter.profiles import Line, Skipped, read_lines
from polars_telemetry.model.insights import Finding, evaluate
from polars_telemetry.model.insights.finding import SCHEMA, duration, share

if TYPE_CHECKING:
    from collections.abc import Sequence

    from polars_telemetry.model.types import Query

_FAILS = {"warn": {"warn"}, "info": {"warn", "info"}}
_INDENT = " " * 19


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return _insights(args, sys.stdout)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="polars-telemetry")
    commands = parser.add_subparsers(dest="command", required=True)
    insights = commands.add_parser("insights", help="find what slows the queries in profile files")
    insights.add_argument("files", nargs="+", type=Path, help="session files (.jsonl)")
    insights.add_argument("--format", choices=("text", "json"), default="text")
    insights.add_argument("--all", action="store_true", help="list information as well")
    insights.add_argument(
        "--fail-on", choices=tuple(_FAILS), help="exit with 1 when a finding reaches this level"
    )
    insights.add_argument(
        "--write", type=Path, metavar="OUT", help="also write the profiles with their insights"
    )
    return parser


def _insights(args: argparse.Namespace, out: TextIO) -> int:
    results: list[tuple[Path, Query, tuple[Finding, ...]]] = []
    skipped: list[tuple[Path, Skipped]] = []
    unreadable = False
    with contextlib.ExitStack() as stack:
        written = stack.enter_context(args.write.open("wb")) if args.write else None
        for path in args.files:
            try:
                for line in read_lines(path):
                    if isinstance(line.read, Skipped):
                        skipped.append((path, line.read))
                    elif line.read is not None:
                        found = evaluate(line.read)
                        results.append((path, line.read, found))
                        if line.document is not None and "profile" not in line.document:
                            line = _with_insights(line, found)
                    if written is not None and line.raw.strip():
                        written.write(line.raw + b"\n")
            except OSError as exc:
                unreadable = True
                print(
                    f"polars-telemetry: cannot read {path}: {exc.strerror or exc}", file=sys.stderr
                )
    if args.format == "json":
        json.dump([_record(path, query, found) for path, query, found in results], out, indent=1)
        out.write("\n")
    else:
        _text(results, skipped, show_all=args.all, out=out)
    if unreadable:
        return 2
    failing = _FAILS.get(args.fail_on or "", set())
    return int(any(f.level in failing for _, _, found in results for f in found))


def _with_insights(line: Line, found: tuple[Finding, ...]) -> Line:
    document = {
        **(line.document or {}),
        "insights": {"schema": SCHEMA, "findings": [f.to_dict() for f in found]},
    }
    raw = json.dumps(document, separators=(",", ":"), default=str).encode("utf-8")
    return Line(line.number, raw, document, line.read)


def _record(path: Path, query: Query, found: tuple[Finding, ...]) -> dict[str, Any]:
    return {
        "file": str(path),
        "query_id": str(query.query_id),
        "label": query.label,
        "wall_ms": query.wall_ms,
        "insights": {"schema": SCHEMA, "findings": [f.to_dict() for f in found]},
    }


def _text(
    results: list[tuple[Path, Query, tuple[Finding, ...]]],
    skipped: list[tuple[Path, Skipped]],
    *,
    show_all: bool,
    out: TextIO,
) -> None:
    levels: Counter[str] = Counter()
    for path, query, found in sorted(results, key=lambda r: -r[1].wall_ms):
        levels.update(f.level for f in found)
        shown = [f for f in found if show_all or f.level == "warn"]
        hidden = Counter(f.rule for f in found if f not in shown)
        if not found:
            continue
        name = query.label or str(query.query_id)
        out.write(
            f"{path.name} · {name}  ({duration(query.wall_ms)} wall, "
            f"{duration(query.cpu_ms)} CPU, {len(query.plan)} nodes)\n"
        )
        for finding in shown:
            out.write(
                f"  {_level(finding)}  {finding.title}  "
                f"[{finding.rule}, {finding.node_kind} #{finding.node_id}]\n"
            )
            if finding.evidence:
                out.write(f"{_INDENT}{' · '.join(map(str, finding.evidence))}\n")
            if finding.fix:
                out.write(f"{_INDENT}fix: {finding.fix}\n")
        if hidden:
            listed = ", ".join(f"{rule} x{count}" for rule, count in hidden.most_common())
            out.write(
                f"  {sum(hidden.values())} more as information: {listed} (--all lists them)\n"
            )
        out.write("\n")
    for path, entry in skipped:
        out.write(f"{path.name}: line {entry.line} skipped: {entry.reason}\n")
    out.write(f"{_summary(len(results), levels)}\n")


def _summary(queries: int, levels: Counter[str]) -> str:
    def counted(n: int, word: str, plural: str) -> str:
        return f"{n} {word if n == 1 else plural}"

    parts = [counted(levels["warn"], "warning", "warnings"), f"{levels['info']} information"]
    if levels["applied"]:
        parts.append(f"{levels['applied']} applied")
    return f"{counted(queries, 'query', 'queries')}: {', '.join(parts)}"


def _level(finding: Finding) -> str:
    if finding.level == "applied":
        return "applied       "
    impact = finding.impact
    basis = "wall" if impact.blocked_share > impact.cpu_share else "CPU"
    return f"{finding.level:4} {share(impact.largest):>5} {basis:<4}"


if __name__ == "__main__":
    raise SystemExit(main())
