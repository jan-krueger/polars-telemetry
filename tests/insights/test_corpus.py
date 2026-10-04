"""Every rule over the TPC-H examples: what fires is pinned, so a change shows in review."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from polars_telemetry.adapter.profiles import read_profiles
from polars_telemetry.model.insights import evaluate
from polars_telemetry.model.types import Query

EXAMPLES = Path(__file__).parents[2] / "examples"

# tpch/q20 asks for unique() on keys that are already unique in TPC-H's data.
EXPECTED = {
    ("tpch-sf1", "tpch/q20", "redundant_aggregation"): 3,
    ("tpch-sf10", "tpch/q20", "redundant_aggregation"): 3,
}

_QUOTED = re.compile(r'"((?:[^"\\]|\\.){3,})"')


def corpus() -> list[tuple[str, Query]]:
    return [
        (path.stem, read)
        for path in sorted(EXAMPLES.glob("*.jsonl"))
        for read in read_profiles(path)
        if isinstance(read, Query)
    ]


def test_tpch_fires_exactly_the_pinned_findings():
    fired = Counter((name, q.label, f.rule) for name, q in corpus() for f in evaluate(q))
    assert dict(fired) == EXPECTED


def test_no_finding_repeats_a_name_or_literal_from_its_plan():
    for _, query in corpus():
        found = evaluate(query)
        if not found:
            continue
        texts = " ".join(f"{f.title} {f.detail}" for f in found)
        quoted = {
            m.group(1)
            for node in (*query.plan.values(), *query.logical.values())
            for text in map(str, node.properties.values())
            for m in _QUOTED.finditer(text)
        }
        leaked = {q for q in quoted if q in texts}
        assert not leaked, (query.label, leaked)
