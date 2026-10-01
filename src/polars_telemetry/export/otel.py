"""OpenTelemetry spans and metrics.

Depends on the OTel *API* only. Where the spans go is the application's
business; this package never configures a provider.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query


class OTelExporter:
    """Query span, child span per node, and per-node metric instruments."""

    def __init__(self, config: Config) -> None:
        raise NotImplementedError

    def export(self, query: Query) -> None:
        raise NotImplementedError
