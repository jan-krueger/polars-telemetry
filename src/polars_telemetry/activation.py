"""Layer 0 -- how polars comes to call us.

polars resolves ``polars_cloud.QueryCloudObserver`` by name on a Python module
and duck-types the result. We supply that name. If the real polars-cloud is
installed we wrap its factory and forward to it rather than displacing a
product the user may be paying for.

This module is the only place that knows polars exists at import time.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.config import Config


def install(config: Config | None = None) -> None:
    """Activate instrumentation for this process.

    Runs the capability probe, registers the observer factory, and enables
    polars' monitoring. Idempotent. Raises only on a configuration error --
    never on an incompatible polars, which degrades with a warning instead.
    """
    raise NotImplementedError


def uninstall() -> None:
    """Deactivate instrumentation and restore any wrapped factory.

    Does not restore the previous engine affinity: polars does not expose that,
    and silently changing it back would be its own surprise.
    """
    raise NotImplementedError
