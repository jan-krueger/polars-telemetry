"""OpenTelemetry instrumentation for Polars query execution."""

from __future__ import annotations

__version__ = "0.0.0"

__all__ = ["Config", "__version__", "install", "uninstall"]

from polars_telemetry.activation import install, uninstall
from polars_telemetry.config import Config
