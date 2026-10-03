"""Failure isolation.

Instrumentation runs inside the caller's data path, so no defect here may
surface as an exception in their query. Errors are counted, each distinct one
logged once, and after a threshold the hook stops doing work for the rest of
the process.
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import ParamSpec, TypeVar

_log = logging.getLogger("polars_telemetry")

P = ParamSpec("P")
R = TypeVar("R")

DEFAULT_MAX_ERRORS = 5


@dataclass
class FailureTracker:
    """Counts failures for one subsystem and disarms it past a threshold."""

    label: str
    max_errors: int = DEFAULT_MAX_ERRORS
    errors: int = 0
    disarmed: bool = False
    _reported: set[str] = field(default_factory=set, repr=False)

    def record(self, exc: Exception) -> None:
        self.errors += 1
        key = f"{type(exc).__name__}: {exc}"
        if key not in self._reported:
            self._reported.add(key)
            _log.warning(
                "polars-telemetry: %s failed (%s). Telemetry may be incomplete; "
                "queries are unaffected.",
                self.label,
                key,
                exc_info=exc,
            )
        if not self.disarmed and self.errors >= self.max_errors:
            self.disarm()

    def note(self, exc: Exception, what: str) -> None:
        """Log, once, that a polars payload was not in the expected shape.

        Not counted toward disarming: a payload polars has changed fails the
        same way on every query, and counting it would switch off query spans
        that never needed that payload.
        """
        key = f"{what}: {type(exc).__name__}: {exc}"
        if key in self._reported:
            return
        self._reported.add(key)
        _log.warning(
            "polars-telemetry: the %s from polars is not in the expected shape (%s: %s); "
            "continuing without it.",
            what,
            type(exc).__name__,
            exc,
        )

    def disarm(self) -> None:
        if self.disarmed:
            return
        self.disarmed = True
        _log.warning(
            "polars-telemetry: disabling %s after %d errors. Queries are unaffected.",
            self.label,
            self.errors,
        )


def fail_soft(
    tracker: FailureTracker,
) -> Callable[[Callable[P, R]], Callable[P, R | None]]:
    """Swallow exceptions from the wrapped callable, returning None instead.

    Skips the call entirely once the tracker is disarmed. BaseException is not
    caught: KeyboardInterrupt and SystemExit must still reach the caller.
    """

    def decorate(fn: Callable[P, R]) -> Callable[P, R | None]:
        @functools.wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R | None:
            if tracker.disarmed:
                return None
            try:
                return fn(*args, **kwargs)
            except Exception as exc:
                tracker.record(exc)
                return None

        return wrapper

    return decorate
