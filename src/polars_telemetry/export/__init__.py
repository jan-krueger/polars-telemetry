"""Layer 3 -- turning the model into telemetry.

Knows nothing about polars. Swappable, so the console exporter can be used for
debugging without any OTel setup at all.
"""

from __future__ import annotations

__all__ = ["ConsoleExporter", "Exporter", "OTelExporter"]

from polars_telemetry.export.base import Exporter
from polars_telemetry.export.console import ConsoleExporter
from polars_telemetry.export.otel import OTelExporter
