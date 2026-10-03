"""Derive the viewer's test fixture from the captured polars payloads.

The viewer must keep up with what the Python side writes; deriving the fixture
from the same captured payloads means the two cannot drift apart silently.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest import mock
from uuid import UUID

from packaging.version import Version

from polars_telemetry.adapter.build import build_metrics, build_plan, enrich
from polars_telemetry.adapter.dialect import _BY_KIND
from polars_telemetry.export.profile import build_profile
from polars_telemetry.model.types import CallSite, Query

ROOT = Path(__file__).parents[2]


def profile_document() -> dict[str, object]:
    """The profile the viewer's contract tests read."""
    fixture = max(
        (p for p in (ROOT / "tests" / "fixtures").iterdir() if p.is_dir()),
        key=lambda p: Version(p.name),
    )
    query = Query(
        query_id=UUID("01a10000-0000-7000-8000-000000000000"),
        wall_ms=48.1,
        plan=build_plan(json.loads((fixture / "physical.json").read_text())),
        logical=build_plan(json.loads((fixture / "ir.json").read_text())),
        metrics=build_metrics(json.loads((fixture / "metrics.json").read_text())),
        call_site=CallSite("/srv/app/pipeline.py", 142, "build_report"),
        started_unix_ns=1_759_478_400_000_000_000,
        polars_version=fixture.name,
    )
    with mock.patch.object(os, "cpu_count", return_value=8):
        return build_profile(enrich(query))


def dialect_table() -> dict[str, str]:
    """The roles the viewer derives for profiles written before `role` existed."""
    return {kind: role.value for kind, role in sorted(_BY_KIND.items())}


def render(document: object) -> str:
    return json.dumps(document, indent=1) + "\n"


def main() -> None:
    out = ROOT / "viewer" / "tests" / "fixtures"
    out.mkdir(parents=True, exist_ok=True)
    (out / "profile.json").write_text(render(profile_document()))
    (out / "dialect.json").write_text(render(dialect_table()))
    print(f"wrote {out.relative_to(ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
