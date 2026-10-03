"""Derive the viewer's test fixture from the captured polars payloads.

The viewer must keep up with what the Python side writes; deriving the fixture
from the same captured payloads means the two cannot drift apart silently.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import uuid4

from polars_telemetry._callsite import CallSite
from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.export.profile import build_profile
from polars_telemetry.model.types import Query

ROOT = Path(__file__).parents[2]


def main() -> None:
    fixture = sorted(p for p in (ROOT / "tests" / "fixtures").iterdir() if p.is_dir())[-1]
    query = Query(
        query_id=uuid4(),
        wall_ms=48.1,
        plan=build_plan(json.loads((fixture / "physical.json").read_text())),
        logical=build_plan(json.loads((fixture / "ir.json").read_text())),
        metrics=build_metrics(json.loads((fixture / "metrics.json").read_text())),
        call_site=CallSite("/srv/app/pipeline.py", 142, "build_report"),
        started_unix_ns=1_759_478_400_000_000_000,
    )
    out = ROOT / "viewer" / "tests" / "fixtures" / "profile.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build_profile(query), indent=1) + "\n")
    print(f"wrote {out.relative_to(ROOT)} from {fixture.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
