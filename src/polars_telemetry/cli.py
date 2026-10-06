"""The `polars-telemetry` command."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING, Any, TextIO

from polars_telemetry.adapter.profiles import Skipped, read_profile, read_profiles
from polars_telemetry.model.insights import Finding, evaluate
from polars_telemetry.model.insights.finding import SCHEMA, duration, share

if TYPE_CHECKING:
    from collections.abc import Sequence

    from polars_telemetry.model.types import Query

_FAILS = {"warn": {"warn"}, "info": {"warn", "info"}}
_INDENT = " " * 19


def main(argv: Sequence[str] | None = None) -> int:
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
    args = parser.parse_args(argv)
    return _insights(args, sys.stdout)


def _insights(args: argparse.Namespace, out: TextIO) -> int:
    results: list[tuple[Path, Query, tuple[Finding, ...]]] = []
    skipped: list[tuple[Path, Skipped]] = []
    for path in args.files:
        for read in read_profiles(path):
            if isinstance(read, Skipped):
                skipped.append((path, read))
            else:
                results.append((path, read, evaluate(read)))
    if args.write:
        _write(args.files, args.write)
    if args.format == "json":
        json.dump([_record(path, query, found) for path, query, found in results], out, indent=1)
        out.write("\n")
    else:
        _text(results, skipped, show_all=args.all, out=out)
    failing = _FAILS.get(args.fail_on or "", set())
    return int(any(f.level in failing for _, _, found in results for f in found))


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


def _write(files: Sequence[Path], target: Path) -> None:
    with target.open("w", encoding="utf-8") as written:
        for path in files:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    document = json.loads(line)
                    found = evaluate(read_profile(document))
                except (ValueError, KeyError, TypeError):
                    written.write(line + "\n")
                    continue
                document["insights"] = {"schema": SCHEMA, "findings": [f.to_dict() for f in found]}
                written.write(json.dumps(document, separators=(",", ":"), default=str) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
