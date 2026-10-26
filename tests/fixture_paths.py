"""Where the captured polars payloads live, and which capture is the newest."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from packaging.version import Version

from polars_telemetry.adapter.decode import decode_metrics

FIXTURE_ROOT = Path(__file__).parent / "fixtures"


def captures() -> list[Path]:
    """Every captured polars version, oldest first."""
    return sorted((p for p in FIXTURE_ROOT.iterdir() if p.is_dir()), key=lambda p: Version(p.name))


def latest_fixture() -> Path:
    return captures()[-1]


def fixture_metrics(capture: Path) -> list[dict[str, Any]]:
    """The node rows of a capture, whichever snapshot shape its polars sent."""
    return decode_metrics((capture / "metrics.msgpack").read_bytes())
