"""Where the captured polars payloads live, and which capture is the newest."""

from __future__ import annotations

from pathlib import Path

from packaging.version import Version

FIXTURE_ROOT = Path(__file__).parent / "fixtures"


def captures() -> list[Path]:
    """Every captured polars version, oldest first."""
    return sorted((p for p in FIXTURE_ROOT.iterdir() if p.is_dir()), key=lambda p: Version(p.name))


def latest_fixture() -> Path:
    return captures()[-1]
