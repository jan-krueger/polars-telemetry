"""OpenTelemetry instrumentation for Polars query execution."""

from __future__ import annotations

__version__ = "0.1.1"

__all__ = ["Config", "Session", "__version__", "install", "profile", "uninstall"]

from polars_telemetry.activation import install, uninstall
from polars_telemetry.config import Config
from polars_telemetry.session import Session, profile
