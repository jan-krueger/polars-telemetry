"""Registration of the observer factory with polars.

polars resolves ``polars_cloud.QueryCloudObserver`` by name and duck-types the
result. If the real polars-cloud is installed its factory is wrapped and
forwarded to rather than replaced.

The installation is process-wide state, changed by `install()`, `uninstall()`
and `profile()` blocks from any thread, so every change happens under one lock.
"""

from __future__ import annotations

import atexit
import logging
import os
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
from polars_telemetry.export.base import Redacted

if TYPE_CHECKING:
    from polars_telemetry.export.base import Exporter
    from polars_telemetry.model.redaction import Redaction

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
    before: Before | None = field(default=None, repr=False)


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
        What was installed, including what the probe found about this
            polars; None when this polars cannot be instrumented at all.

    Enabling polars' monitoring sets its engine affinity to `"streaming"`, so
    this changes how queries execute and never happens on import. Calling it
    again while installed logs a warning and changes nothing.
    """
    with _lock:
        return _install(config, _as_tuple(exporter), scoped=False)


def uninstall() -> None:
    """Stop instrumenting, and hand queries back to Polars Cloud if it was there.

    The engine affinity goes back to what it was before `install()`, unless
    the application chose another engine in the meantime.
    """
    with _lock:
        detached = _detach()
    # Outside the lock: a flush can take seconds, and must not hold up another
    # thread's install() or profile() meanwhile. The exporters no longer
    # receive queries, so nothing reaches them while they close.
    _close(detached)


def _detach() -> tuple[Exporter, ...]:
    """Take the installation down, returning its exporters for closing.

    Called with the lock held.
    """
    global _state, _scoped_holders
    if _state is None:
        return ()

    exporters = _state.exporters
    for receiver in _state.receivers:
        _dispatch.remove(receiver)
    try:
        _monitoring_off(_state.before)
    finally:
        mod.unbind(_state.binding)
        _state = None
        _scoped_holders = 0
    return exporters


def _engine_affinity() -> object:
    """The engine `collect()` defaults to: an engine object, a name, or None."""
    try:
        # Where polars keeps engine objects, such as a configured GPUEngine.
        from polars.lazyframe.engine_config import get_engine_affinity_override
    except ImportError:
        override = None
    else:
        override = get_engine_affinity_override()
    return override if override is not None else os.environ.get("POLARS_ENGINE_AFFINITY")


@dataclass(frozen=True)
class Before:
    """polars' settings that monitoring changes, as they were before install()."""

    affinity: object
    monitoring: dict[str, str | None]


_MONITORING_ENV = (
    "POLARS_QUERY_MONITORING",
    "POLARS_QUERY_MONITORING_WORKSPACE",
    "POLARS_QUERY_MONITORING_ORGANIZATION",
)


def _monitoring_on() -> Before:
    import polars as pl

    before = Before(_engine_affinity(), {key: os.environ.get(key) for key in _MONITORING_ENV})
    pl.Config.enable_monitoring()
    _restore_env(before, _MONITORING_ENV[1:])
    return before


def _monitoring_off(before: Before | None) -> None:
    """Put polars' monitoring settings and engine affinity back as they were.

    The affinity only while it is still the streaming one monitoring set: an
    engine chosen since is the application's choice, and stays.
    """
    import polars as pl

    pl.Config.enable_monitoring(False)
    if before is None:
        return
    _restore_env(before, _MONITORING_ENV)
    if _engine_affinity() == "streaming":
        pl.Config.set_engine_affinity(before.affinity)  # type: ignore[arg-type]


def _restore_env(before: Before, keys: tuple[str, ...]) -> None:
    for key in keys:
        value = before.monitoring[key]
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _close(exporters: tuple[Exporter, ...]) -> None:
    """Let exporters that hold data send it: those with a `close()` method."""
    for exporter in exporters:
        target = _unwrapped(exporter)
        close = getattr(target, "close", None)
        if close is None:
            continue
        try:
            close()
        except Exception as exc:
            _log.warning(
                "polars-telemetry: closing %s failed (%s: %s).",
                type(target).__name__,
                type(exc).__name__,
                exc,
            )


@atexit.register
def _close_at_exit() -> None:
    # Most applications never call uninstall(); what an exporter still holds
    # would otherwise go down with the process.
    state = _state
    if state is not None:
        _close(state.exporters)


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
    detached: tuple[Exporter, ...] = ()
    with _lock:
        _scoped_holders = max(_scoped_holders - 1, 0)
        # An application may have adopted the installation meanwhile.
        if _scoped_holders == 0 and _state is not None and _state.scoped:
            detached = _detach()
    _close(detached)


def _install(
    config: Config | None, exporters: tuple[Exporter, ...], *, scoped: bool
) -> Installation | None:
    """Called with the lock held."""
    global _state
    _check(config, exporters)
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

    before = _monitoring_on()
    try:
        return _activate(binding, config, exporters, before, scoped=scoped)
    except BaseException:
        _monitoring_off(before)
        mod.unbind(binding)
        raise


def _activate(
    binding: mod.Binding,
    config: Config | None,
    exporters: tuple[Exporter, ...],
    before: Before,
    *,
    scoped: bool,
) -> Installation | None:
    """Called with the lock held and monitoring on; undone by the caller if it raises."""
    global _state
    capabilities = probe(binding)

    if not capabilities.usable:
        _log.warning(
            "polars-telemetry: polars %s did not deliver the expected observer "
            "interface (%s); instrumentation not installed.",
            capabilities.polars_version,
            "; ".join(capabilities.problems) or "no detail",
        )
        _monitoring_off(before)
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
        before=before,
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
    receivers: list[_dispatch.Receiver] = []
    try:
        for exporter in exporters:
            target, redaction = _redaction_for(exporter, config)
            receivers.append(
                _dispatch.add(
                    target.export, f"exporter {type(target).__name__}", redaction=redaction
                )
            )
    except BaseException:
        for receiver in receivers:
            _dispatch.remove(receiver)
        raise
    return tuple(receivers)


def _check(config: object, exporters: tuple[object, ...]) -> None:
    if config is not None and not isinstance(config, Config):
        msg = f"config must be a polars_telemetry.Config, not {type(config).__name__}"
        raise TypeError(msg)
    for exporter in exporters:
        target = exporter.exporter if isinstance(exporter, Redacted) else exporter
        if not callable(getattr(target, "export", None)):
            msg = f"an exporter needs an export(query) method; got {target!r}"
            raise TypeError(msg)


def _unwrapped(exporter: Exporter) -> Exporter:
    """The exporter itself, without the redaction `redacted()` gave it."""
    return exporter.exporter if isinstance(exporter, Redacted) else exporter


def _redaction_for(exporter: Exporter, config: Config) -> tuple[Exporter, Redaction | None]:
    if isinstance(exporter, Redacted):
        return _unwrapped(exporter), exporter.redaction
    # Before 0.3, OTelExporter masked by the config it was given, whatever
    # install() was given; keep that rather than start sending literals.
    own = getattr(exporter, "config", None)
    if config.redaction is None and isinstance(own, Config) and own.redaction is not None:
        return exporter, own.redaction
    return exporter, config.redaction


def _as_tuple(exporter: Exporter | Sequence[Exporter] | None) -> tuple[Exporter, ...]:
    if exporter is None:
        return ()
    if hasattr(exporter, "export"):
        return (exporter,)
    return tuple(exporter)


def _default_exporter(config: Config) -> Exporter:
    from polars_telemetry.export.otel import OTelExporter

    return OTelExporter(config)
