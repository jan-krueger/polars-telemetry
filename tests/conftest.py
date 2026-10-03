"""Shared fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.fixture_paths import FIXTURE_ROOT


@pytest.fixture(scope="session")
def fixture_root() -> Path:
    """Captured polars payloads, one subdirectory per version."""
    return FIXTURE_ROOT
