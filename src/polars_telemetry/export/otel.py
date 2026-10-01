"""OTel span and metric emission.

Depends on the OTel API only; the SDK and provider are the application's.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query


class OTelExporter:
    """Query span, child span per node, per-node metric instruments."""

    def __init__(self, config: Config) -> None:
        raise NotImplementedError

    def export(self, query: Query) -> None:
        raise NotImplementedError
