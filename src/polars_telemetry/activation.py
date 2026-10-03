"""Registration of the observer factory with polars.

polars resolves ``polars_cloud.QueryCloudObserver`` by name and duck-types the
result. If the real polars-cloud is installed its factory is wrapped and
forwarded to rather than replaced.

The installation is process-wide state, changed by `install()`, `uninstall()`
and `profile()` blocks from any thread, so every change happens under one lock.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING

from polars_telemetry import _dispatch
from polars_telemetry.adapter import module as mod
from polars_telemetry.adapter.hook import ObserverFactory
from polars_telemetry.adapter.recorder import QueryRecorder
from polars_telemetry.compat import SUPPORTED, Capabilities, probe
from polars_telemetry.config import Config

if TYPE_CHECKING:
    from polars_telemetry.export.base import Exporter

_log = logging.getLogger("polars_telemetry")

SUPPORTED_MESSAGE = f"polars {SUPPORTED}"


@dataclass(frozen=True, slots=True)
class Installation:
    """What `install()` put in place."""

    binding: mod.Binding
    config: Config
    capabilities: Capabilities
    exporters: tuple[Exporter, ...] = ()
    scoped: bool = False
    """Made by a profile() block, not by the application; the last block to
    close takes it back out."""
    receivers: tuple[_dispatch.Receiver, ...] = field(default=(), repr=False)


_lock = threading.RLock()
_state: Installation | None = None
_scoped_holders = 0


def installed() -> Installation | None:
    return _state


def install(
    config: Config | None = None,
    exporter: Exporter | Sequence[Exporter] | None = None,
) -> Installation | None:
    """Instrument every polars query this process runs.

    Args:
        config: What to record. Defaults to `Config()`.
        exporter: Where queries go: one exporter or several. Defaults to
            `OTelExporter`.

    Returns:
        What was installed, including what the probe found about this polars;
        None when this polars cannot be instrumented at all.

    Enabling polars' monitoring sets its engine affinity to `"streaming"`, so
    this changes how queries execute and never happens on import. Calling it
    again while installed logs a warning and changes nothing.
    """
    with _lock:
        return _install(config, _as_tuple(exporter), scoped=False)


def uninstall() -> None:
    """Stop instrumenting, and hand queries back to Polars Cloud if it was there.

    The engine affinity stays `"streaming"`; polars exposes no way to read the
    previous value back.
    """
    global _state, _scoped_holders
    with _lock:
        if _state is None:
            return
        import polars as pl

        for receiver in _state.receivers:
            _dispatch.remove(receiver)
        try:
            pl.Config.enable_monitoring(False)
        finally:
            mod.unbind(_state.binding)
            _state = None
            _scoped_holders = 0


def acquire_scoped(config: Config | None) -> bool:
    """For a profile() block: make sure something is installed.

    Returns True when the block holds a scoped installation and must call
    `release_scoped()` when it closes.
    """
    global _scoped_holders
    with _lock:
        state = _install(config, (), scoped=True)
        if state is None or not state.scoped:
            return False
        _scoped_holders += 1
        return True


def release_scoped() -> None:
    global _scoped_holders
    with _lock:
        _scoped_holders = max(_scoped_holders - 1, 0)
        # An application may have adopted the installation meanwhile.
        if _scoped_holders == 0 and _state is not None and _state.scoped:
            uninstall()


def _install(
    config: Config | None, exporters: tuple[Exporter, ...], *, scoped: bool
) -> Installation | None:
    """Called with the lock held."""
    global _state
    if _state is not None:
        return _join(config, exporters, scoped=scoped)

    import polars as pl

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

    if not capabilities.ir_payload_ok:
        _log.warning(
            "polars-telemetry: polars %s delivered an unexpected IR plan; span "
            "attributes will use the physical plan's internal column names.",
            capabilities.polars_version,
        )

    effective = _effective(config or Config(), capabilities)
    mod.set_factory(binding, _factory(effective, binding))
    if not scoped and not exporters:
        exporters = (_default_exporter(effective),)
    _state = Installation(
        binding=binding,
        config=effective,
        capabilities=capabilities,
        exporters=exporters,
        scoped=scoped,
        receivers=_register(exporters, effective),
    )
    return _state


def _join(config: Config | None, exporters: tuple[Exporter, ...], *, scoped: bool) -> Installation:
    """install() or a profile() block meeting an existing installation."""
    global _state
    assert _state is not None  # noqa: S101 - called only when installed
    if scoped:
        return _state

    if _state.scoped:
        # The application is installing while a profile() block is open. It
        # takes ownership: its config and exporters apply, and the block's
        # close no longer uninstalls.
        effective = _effective(config or _state.config, _state.capabilities)
        if effective != _state.config:
            mod.set_factory(_state.binding, _factory(effective, _state.binding))
        exporters = exporters or (_default_exporter(effective),)
        _state = replace(
            _state,
            config=effective,
            exporters=exporters,
            scoped=False,
            receivers=(*_state.receivers, *_register(exporters, effective)),
        )
        return _state

    if (config is not None and config != _state.config) or exporters:
        _log.warning(
            "polars-telemetry: install() was called again with different arguments; "
            "it is already installed, so they are ignored. Call uninstall() first "
            "to change the configuration or exporters."
        )
    return _state


def _factory(config: Config, binding: mod.Binding) -> ObserverFactory:
    return ObserverFactory(
        lambda tracker: QueryRecorder(config, _dispatch.dispatch, tracker),
        delegate=binding.previous_factory,
    )


def _effective(config: Config, capabilities: Capabilities) -> Config:
    if not capabilities.node_metrics_usable and config.node_metrics:
        _log.warning(
            "polars-telemetry: polars %s delivered unexpected plan or metrics "
            "payloads (%s); continuing with query spans only.",
            capabilities.polars_version,
            "; ".join(capabilities.problems) or "no detail",
        )
        return replace(config, node_metrics=False)
    return config


def _register(exporters: tuple[Exporter, ...], config: Config) -> tuple[_dispatch.Receiver, ...]:
    # Redacted before delivery, so an exporter the application wrote is covered
    # by the setting as much as the bundled ones are.
    return tuple(
        _dispatch.add(
            exporter.export,
            f"exporter {type(exporter).__name__}",
            redact=config.redact_literals,
        )
        for exporter in exporters
    )


def _as_tuple(exporter: Exporter | Sequence[Exporter] | None) -> tuple[Exporter, ...]:
    if exporter is None:
        return ()
    if hasattr(exporter, "export"):
        return (exporter,)
    return tuple(exporter)


def _default_exporter(config: Config) -> Exporter:
    from polars_telemetry.export.otel import OTelExporter

    return OTelExporter(config)
