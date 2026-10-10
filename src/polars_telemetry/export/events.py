"""Write what happens to each query, while it runs, to a JSON Lines file.

Where `FileExporter` writes one profile per finished query, this writes the
query's life: announced with its plan once it has run for a moment, sampled
while it runs, and its profile when it finishes. The viewer replays it.

Each line is a complete event:

    {"schema": "polars-telemetry/events@1", "type": "process", ...}
    {"schema": ..., "type": "query.started", "query_id": ..., "plan": {...}}
    {"schema": ..., "type": "query.progress", "query_id": ..., "elapsed_ms": ..., "nodes": {...}}
    {"schema": ..., "type": "query.finished", "query_id": ..., "profile": {...}}

Progress lists only nodes whose counters changed since the previous sample,
and leaves out counters that are zero. Counters are cumulative, so a node's
latest entry is its state at that moment.

A path ending in `.gz` is written gzip-compressed, as one gzip member per
batch: everything up to the last batch can be read even if the process dies.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import socket
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from polars_telemetry._version import __version__
from polars_telemetry.export.profile import _metrics, _node, build_profile

if TYPE_CHECKING:
    from polars_telemetry.model.types import Progress, Query

_log = logging.getLogger("polars_telemetry")

SCHEMA = "polars-telemetry/events@1"

DEFAULT_MAX_BYTES = 256 * 1024 * 1024

_BATCH_BYTES = 256 * 1024
_BATCH_SECONDS = 2.0


def _line(event: dict[str, Any]) -> str:
    return json.dumps({"schema": SCHEMA, **event}, separators=(",", ":"), default=str)


def _counters(progress: Progress) -> dict[str, dict[str, Any]]:
    nodes: dict[str, dict[str, Any]] = {}
    for node_id, metric in progress.nodes.items():
        counters = _metrics(metric) or {}
        nodes[str(node_id)] = {k: v for k, v in counters.items() if v not in (0, False, None)}
    return nodes


class FileEventExporter:
    """Append the life of every query to a `.jsonl` or `.jsonl.gz` file.

    Args:
        path: The events file. Its directory is created if missing. A name
            ending in `.gz` is written compressed.
        max_bytes: 256 MiB by default. When the file would grow past this, it
            moves to `<name>.1`, replacing the previous one, and a new file
            starts.
    """

    __slots__ = (
        "_buffer",
        "_buffered_at",
        "_errors",
        "_gzip",
        "_lock",
        "_max_bytes",
        "_opened",
        "_path",
    )

    def __init__(self, path: str | Path, *, max_bytes: int = DEFAULT_MAX_BYTES) -> None:
        if max_bytes <= 0:
            msg = f"max_bytes must be positive, got {max_bytes}"
            raise ValueError(msg)
        self._path = Path(path)
        self._gzip = self._path.suffix == ".gz"
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._errors = 0
        self._buffer: list[str] = []
        self._buffered_at = 0.0
        self._opened = False
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        """The file being written."""
        return self._path

    def started(self, query: Query) -> None:
        self._write(
            {
                "type": "query.started",
                "query_id": str(query.query_id),
                "started_unix_ns": query.started_unix_ns,
                "label": query.label,
                "fingerprint": query.fingerprint,
                "engine": query.engine,
                "polars_version": query.polars_version,
                "call_site": None
                if query.call_site is None
                else {
                    "filepath": query.call_site.filepath,
                    "lineno": query.call_site.lineno,
                    "function": query.call_site.function,
                },
                "planning_ms": None if query.planning_ms is None else round(query.planning_ms, 4),
                "plan": {
                    "physical": [_node(node, None) for node in query.plan.values()],
                    "logical": [_node(node, None) for node in query.logical.values()],
                },
            },
            urgent=False,
        )

    def progress(self, progress: Progress) -> None:
        self._write(
            {
                "type": "query.progress",
                "query_id": str(progress.query_id),
                "elapsed_ms": round(progress.elapsed_ms, 1),
                "nodes": _counters(progress),
            },
            urgent=False,
        )

    def export(self, query: Query) -> None:
        self._write(
            {
                "type": "query.finished",
                "query_id": str(query.query_id),
                "profile": build_profile(query),
            },
            urgent=True,
        )

    def close(self) -> None:
        """Write what is buffered. `uninstall()` calls it, and so does exit."""
        with self._lock:
            self._flush()

    def _write(self, event: dict[str, Any], *, urgent: bool) -> None:
        try:
            line = _line(event)
        except Exception as exc:
            self._record(exc, "building an event")
            return
        with self._lock:
            if not self._buffer:
                self._buffered_at = time.monotonic()
            if not self._opened:
                self._opened = True
                self._buffer.append(_line(_process()))
            self._buffer.append(line)
            size = sum(len(entry) for entry in self._buffer)
            if (
                urgent
                or size >= _BATCH_BYTES
                or time.monotonic() - self._buffered_at >= _BATCH_SECONDS
            ):
                self._flush()

    def _flush(self) -> None:
        if not self._buffer:
            return
        data = ("\n".join(self._buffer) + "\n").encode("utf-8")
        self._buffer = []
        try:
            if self._gzip:
                data = gzip.compress(data)
            self._rotate_if_needed(len(data))
            with self._path.open("ab") as handle:
                handle.write(data)
        except Exception as exc:
            self._record(exc, f"writing to {self._path}")

    def _rotate_if_needed(self, incoming: int) -> None:
        try:
            current = self._path.stat().st_size
        except FileNotFoundError:
            return
        if current + incoming <= self._max_bytes:
            return
        os.replace(self._path, self._path.with_name(self._path.name + ".1"))

    def _record(self, exc: Exception, doing: str) -> None:
        self._errors += 1
        if self._errors == 1:
            _log.warning(
                "polars-telemetry: event export failed while %s (%s: %s). Queries are unaffected.",
                doing,
                type(exc).__name__,
                exc,
            )

    @property
    def errors(self) -> int:
        """How many writes have failed."""
        return self._errors


def _process() -> dict[str, Any]:
    return {
        "type": "process",
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "started_unix_ns": time.time_ns(),
        "polars_telemetry_version": __version__,
    }
