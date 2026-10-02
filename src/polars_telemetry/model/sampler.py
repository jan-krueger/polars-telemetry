"""Metrics polling for one query."""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING

from polars_telemetry.config import SamplingMode
from polars_telemetry.model.build import build_sample

if TYPE_CHECKING:
    from polars_telemetry.adapter.handle import MetricsHandle
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Sample

# polars can call close() before the engine's final counters settle. Rather
# than always paying a fixed delay, retake the snapshot only while nodes still
# report done=False, up to this budget.
_SETTLE_ATTEMPTS = 5
_SETTLE_WAIT_S = 0.001


class Sampler:
    """Collects samples over a query. One instance per query."""

    __slots__ = ("_config", "_handle", "_samples", "_started", "_stop", "_thread")

    def __init__(self, handle: MetricsHandle, config: Config) -> None:
        self._handle = handle
        self._config = config
        self._samples: list[Sample] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = 0.0

    def start(self) -> None:
        """Begin sampling. Starts a daemon thread only in INTERVAL mode."""
        self._started = time.perf_counter()
        if self._config.sampling is not SamplingMode.INTERVAL:
            return
        self._thread = threading.Thread(
            target=self._poll, name="polars-telemetry-sampler", daemon=True
        )
        self._thread.start()

    def stop(self) -> tuple[Sample, ...]:
        """Stop polling, take the closing snapshot, return all samples."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        if self._config.sampling is not SamplingMode.OFF:
            self._samples.append(self._settled_snapshot())
        return tuple(self._samples)

    @property
    def elapsed_ms(self) -> float:
        return (time.perf_counter() - self._started) * 1000

    def _poll(self) -> None:
        interval = self._config.interval_ms / 1000
        while not self._stop.wait(interval):
            self._samples.append(self._snapshot())

    def _snapshot(self) -> Sample:
        return build_sample(self.elapsed_ms, self._handle.snapshot())

    def _settled_snapshot(self) -> Sample:
        sample = self._snapshot()
        for _ in range(_SETTLE_ATTEMPTS):
            if not sample.nodes or all(node.done for node in sample.nodes.values()):
                return sample
            time.sleep(_SETTLE_WAIT_S)
            sample = self._snapshot()
        return sample
