"""The observer protocol polars calls.

Verified against polars 1.44.1 and 1.44.2::

    polars_cloud.authenticate()
    polars_cloud.QueryCloudObserver(workspace, organization) -> observer
    observer.on_query_started(query_id: UUID)
    observer.on_query_planned(query_id, handle, ir: bytes, phys: bytes) -> guard
    observer.on_query_failed(...)
    guard.close()

Names and signatures are dictated by polars and must not be renamed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    from polars_telemetry.config import Config


class ObserverFactory:
    """Called by polars once per query."""

    def __init__(self, config: Config, delegate: Any | None = None) -> None:
        """delegate: the real polars-cloud factory, if one was installed."""
        raise NotImplementedError

    def __call__(
        self, workspace: str | None = None, organization: str | None = None
    ) -> QueryObserver:
        raise NotImplementedError


class QueryObserver:
    """One query's callbacks. Each method is failure-isolated."""

    def on_query_started(self, query_id: UUID) -> None:
        raise NotImplementedError

    def on_query_planned(
        self, query_id: UUID, handle: Any, ir_plan: bytes, physical_plan: bytes
    ) -> ExecutionGuard:
        raise NotImplementedError

    def on_query_failed(self, *args: Any) -> None:
        raise NotImplementedError


class ExecutionGuard:
    """Returned from on_query_planned; polars calls close() at query end.

    close() can fire before the engine's final flush lands, so the closing
    snapshot is reconciled here.
    """

    def close(self) -> None:
        raise NotImplementedError
