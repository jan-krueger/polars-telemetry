"""Registration of the observer factory with polars.

polars resolves ``polars_cloud.QueryCloudObserver`` by name and duck-types the
result. If the real polars-cloud is installed its factory is wrapped and
forwarded to rather than replaced.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from polars_telemetry.adapter import module as mod
from polars_telemetry.adapter.observer import ObserverFactory
from polars_telemetry.compat import Capabilities, probe
from polars_telemetry.config import Config

if TYPE_CHECKING:
    from polars_telemetry.export.base import Exporter

_log = logging.getLogger("polars_telemetry")


@dataclass(frozen=True, slots=True)
class Installation:
    """What install() put in place, so uninstall() can take it back out."""

    binding: mod.Binding
    config: Config
    capabilities: Capabilities


_state: Installation | None = None


def installed() -> Installation | None:
    return _state


def install(config: Config | None = None, exporter: Exporter | None = None) -> Installation | None:
    """Activate instrumentation for this process. Idempotent.

    Activation is explicit because enabling monitoring sets polars' engine
    affinity to "streaming". Raises on invalid config only; an unsupported
    polars degrades with a warning.

    Returns None when the installed polars cannot be instrumented at all.
    """
    global _state
    if _state is not None:
        return _state

    import polars as pl

    config = config or Config()
    binding = mod.bind()

    if not hasattr(pl.Config, "enable_monitoring"):
        _log.warning(
            "polars-telemetry: polars %s has no query monitoring API (need %s); "
            "instrumentation not installed.",
            pl.__version__,
            SUPPORTED_MESSAGE,
        )
        mod.unbind(binding)
        return None

    pl.Config.enable_monitoring()
    capabilities = probe(binding)

    if not capabilities.usable:
        _log.warning(
            "polars-telemetry: polars %s did not deliver the expected observer "
            "interface (%s); instrumentation not installed.",
            capabilities.polars_version,
            "; ".join(capabilities.problems) or "no detail",
        )
        pl.Config.enable_monitoring(False)
        mod.unbind(binding)
        return None

    if not capabilities.node_metrics_usable and config.node_metrics:
        _log.warning(
            "polars-telemetry: polars %s delivered unexpected plan or metrics "
            "payloads (%s); continuing with query spans only.",
            capabilities.polars_version,
            "; ".join(capabilities.problems) or "no detail",
        )
        config = replace(config, node_metrics=False)

    if exporter is None:
        exporter = _default_exporter(config)

    factory = ObserverFactory(config, exporter, delegate=binding.previous_factory)
    mod.set_factory(binding, factory)

    _state = Installation(binding=binding, config=config, capabilities=capabilities)
    return _state


def uninstall() -> None:
    """Deactivate and restore any wrapped factory.

    Engine affinity is not restored; polars exposes no way to read the
    previous value.
    """
    global _state
    if _state is None:
        return

    import polars as pl

    try:
        pl.Config.enable_monitoring(False)
    finally:
        mod.unbind(_state.binding)
        _state = None


def _default_exporter(config: Config) -> Exporter:
    from polars_telemetry.export.otel import OTelExporter

    return OTelExporter(config)


SUPPORTED_MESSAGE = "polars >=1.44.1"
