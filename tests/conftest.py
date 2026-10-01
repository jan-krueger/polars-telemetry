"""Shared fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

FIXTURE_ROOT = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def fixture_root() -> Path:
    """Captured polars payloads, one subdirectory per version."""
    return FIXTURE_ROOT
