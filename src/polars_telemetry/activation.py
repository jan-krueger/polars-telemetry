"""Registration of the observer factory with polars.

polars resolves ``polars_cloud.QueryCloudObserver`` by name and duck-types the
result. If the real polars-cloud is installed its factory is wrapped and
forwarded to rather than replaced.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.config import Config


def install(config: Config | None = None) -> None:
    """Activate instrumentation for this process. Idempotent.

    Activation is explicit because enabling monitoring sets polars' engine
    affinity to "streaming". Raises on invalid config only; an unsupported
    polars degrades with a warning.
    """
    raise NotImplementedError


def uninstall() -> None:
    """Deactivate and restore any wrapped factory.

    Engine affinity is not restored; polars exposes no way to read the
    previous value.
    """
    raise NotImplementedError
