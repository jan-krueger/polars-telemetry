"""OpenTelemetry instrumentation for Polars query execution."""

from __future__ import annotations

from polars_telemetry._version import __version__

__all__ = ["Config", "Session", "__version__", "install", "label", "profile", "uninstall"]

from polars_telemetry.activation import install, uninstall
from polars_telemetry.config import Config
from polars_telemetry.labels import label
from polars_telemetry.session import Session, profile
