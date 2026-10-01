"""The package imports and exposes what it promises."""

from __future__ import annotations

import polars_telemetry


def test_version_is_a_string() -> None:
    assert isinstance(polars_telemetry.__version__, str)
    assert polars_telemetry.__version__


def test_public_surface() -> None:
    for name in polars_telemetry.__all__:
        assert hasattr(polars_telemetry, name), name
