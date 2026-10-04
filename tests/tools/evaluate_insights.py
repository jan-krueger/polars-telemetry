"""Check insight rules against what real runs are known to show.

    uv run python tests/tools/evaluate_insights.py expectations.json

The expectations file names profile files and, per query, which findings must
appear and which must not. It stays next to the data it describes, outside the
repository:

    {"cases": [{"file": "~/runs/nightly-1.jsonl", "query": "largest",
                "fires": ["in_memory_fallback", "repeated_string_scan:str.contains"],
                "absent": ["cross_join"]}]}

`query` is a label or "largest" for the longest-running query. An entry is a
rule id, optionally followed by `:` and text the finding's title must contain.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from polars_telemetry.adapter.profiles import read_profiles
from polars_telemetry.model.insights import Finding, evaluate
from polars_telemetry.model.types import Query


def matches(entry: str, finding: Finding) -> bool:
    rule, _, text = entry.partition(":")
    return finding.rule == rule and text in finding.title


def check(case: dict[str, Any]) -> list[str]:
    path = Path(case["file"]).expanduser()
    queries = [q for q in read_profiles(path) if isinstance(q, Query)]
    wanted = case.get("query", "largest")
    chosen = (
        max(queries, key=lambda q: q.wall_ms)
        if wanted == "largest"
        else next((q for q in queries if q.label == wanted), None)
    )
    if chosen is None:
        return [f"{path.name}: no query {wanted!r}"]
    found = evaluate(chosen)
    problems = [
        f"{path.name}: expected {entry}"
        for entry in case.get("fires", [])
        if not any(matches(entry, f) for f in found)
    ]
    problems += [
        f"{path.name}: did not expect {entry}"
        for entry in case.get("absent", [])
        if any(matches(entry, f) for f in found)
    ]
    return problems


def main(argv: list[str]) -> int:
    cases = json.loads(Path(argv[1]).read_text())["cases"]
    problems = [problem for case in cases for problem in check(case)]
    for problem in problems:
        print(f"FAIL {problem}")
    print(f"{len(cases)} cases, {len(problems)} failures")
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
