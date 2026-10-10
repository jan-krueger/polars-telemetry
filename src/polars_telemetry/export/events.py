"""Write what happens to each query, while it runs, to a JSON Lines file.

Where `FileExporter` writes one profile per finished query, this writes the
query's life: its profile without counters once it has run for a moment,
samples while it runs, and its full profile when it finishes. The viewer
replays it.

Each line is a complete event:

    {"schema": "polars-telemetry/events@1", "seq": 1, "type": "process", "id": ..., ...}
    {"schema": ..., "seq": 2, "type": "query.started", "query_id": ..., "profile": {...}}
    {"schema": ..., "seq": 3, "type": "query.progress", "query_id": ..., "nodes": {...}, ...}
    {"schema": ..., "seq": 4, "type": "query.finished", "query_id": ..., "profile": {...}}

The process line's `id` names this exporter's stream of events, and `seq`
numbers each event in it, so a receiver can tell a repeated event from a new
one. Progress lists only nodes whose counters changed since the previous
sample, and leaves out counters that are zero. Counters are cumulative, so a
node's latest entry is its state at that moment.

A path ending in `.gz` is written gzip-compressed, as one gzip member per
batch: everything up to the last batch can be read even if the process dies.
"""

from __future__ import annotations

import gzip
import itertools
import json
import os
import socket
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from polars_telemetry._version import __version__
from polars_telemetry.export.file import RotatingFile
from polars_telemetry.export.profile import build_profile
from polars_telemetry.model.types import COUNTER_NAMES

if TYPE_CHECKING:
    from polars_telemetry.model.types import Progress, Query

SCHEMA = "polars-telemetry/events@1"

DEFAULT_MAX_BYTES = 256 * 1024 * 1024

_BATCH_BYTES = 256 * 1024
_BATCH_SECONDS = 2.0


def _counters(progress: Progress) -> dict[str, dict[str, Any]]:
    nodes: dict[str, dict[str, Any]] = {}
    for node_id, metric in progress.nodes.items():
        counters: dict[str, Any] = {
            name: value for name in COUNTER_NAMES if (value := getattr(metric, name))
        }
        if metric.done:
            counters["done"] = True
        if metric.custom:
            counters["custom"] = [
                {"key": c.key, "unit": c.unit, "value": c.value} for c in metric.custom
            ]
        nodes[str(node_id)] = counters
    return nodes


def started_event(query: Query) -> dict[str, Any]:
    return {
        "type": "query.started",
        "query_id": str(query.query_id),
        "profile": build_profile(query),
    }


def progress_event(progress: Progress) -> dict[str, Any]:
    return {
        "type": "query.progress",
        "query_id": str(progress.query_id),
        "elapsed_ms": round(progress.elapsed_ms, 1),
        "nodes": _counters(progress),
    }


def finished_event(query: Query) -> dict[str, Any]:
    return {
        "type": "query.finished",
        "query_id": str(query.query_id),
        "profile": build_profile(query),
    }


class Stream:
    """One exporter's events: the process line that names them, and a number for each."""

    __slots__ = ("_process", "_seq")

    def __init__(self, service: str | None, environment: str | None) -> None:
        self._seq = itertools.count(1)
        self._process = {
            "type": "process",
            "id": str(uuid4()),
            "service": service,
            "environment": environment,
            "host": socket.gethostname(),
            "pid": os.getpid(),
            "polars_telemetry_version": __version__,
        }

    def process(self) -> str:
        """A process line, numbered like any event."""
        return self.line({**self._process, "started_unix_ns": time.time_ns()})

    def line(self, event: dict[str, Any]) -> str:
        return json.dumps(
            {"schema": SCHEMA, "seq": next(self._seq), **event}, separators=(",", ":"), default=str
        )


class FileEventExporter:
    """Append the life of every query to a `.jsonl` or `.jsonl.gz` file.

    Args:
        path: The events file. Its directory is created if missing. A name
            ending in `.gz` is written compressed.
        service: What the process is, such as `"orders-etl"`. Written on the
            process line so a dashboard can group by it.
        environment: Where it runs, such as `"prod"`. Also on the process line.
        max_bytes: 256 MiB by default. When the file would grow past this, it
            moves to `<name>.1`, replacing the previous one, and a new file
            starts.
    """

    __slots__ = (
        "_buffer",
        "_buffered",
        "_buffered_at",
        "_closed",
        "_file",
        "_gzip",
        "_lock",
        "_opened",
        "_stream",
    )

    def __init__(
        self,
        path: str | Path,
        *,
        service: str | None = None,
        environment: str | None = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self._file = RotatingFile(path, max_bytes, "event")
        self._stream = Stream(service, environment)
        self._gzip = self._file.path.suffix == ".gz"
        self._lock = threading.Lock()
        self._buffer: list[str] = []
        self._buffered = 0
        self._buffered_at = 0.0
        self._opened = False
        self._closed = False

    @property
    def path(self) -> Path:
        """The file being written."""
        return self._file.path

    @property
    def errors(self) -> int:
        """How many writes have failed."""
        return self._file.errors

    def started(self, query: Query) -> None:
        self._write(started_event(query), urgent=True)

    def progress(self, progress: Progress) -> None:
        self._write(progress_event(progress))

    def export(self, query: Query) -> None:
        self._write(finished_event(query), urgent=True)

    def close(self) -> None:
        """Write what is buffered. `uninstall()` calls it, and so does exit."""
        with self._lock:
            self._flush()
            self._closed = True

    def _write(self, event: dict[str, Any], *, urgent: bool = False) -> None:
        with self._lock:
            if not self._buffer:
                self._buffered_at = time.monotonic()
            if not self._opened:
                self._opened = True
                self._append(self._stream.process())
            try:
                line = self._stream.line(event)
            except Exception as exc:
                self._file.record(exc, "building an event")
                return
            self._append(line)
            if (
                urgent
                or self._closed
                or self._buffered >= _BATCH_BYTES
                or time.monotonic() - self._buffered_at >= _BATCH_SECONDS
            ):
                self._flush()

    def _append(self, line: str) -> None:
        self._buffer.append(line)
        self._buffered += len(line) + 1

    def _flush(self) -> None:
        if not self._buffer:
            return
        data = ("\n".join(self._buffer) + "\n").encode("utf-8")
        self._buffer = []
        self._buffered = 0
        try:
            data = self._encode(data)
            if self._file.rotate_if_needed(len(data)):
                data = self._encode((self._stream.process() + "\n").encode("utf-8")) + data
            with self._file.path.open("ab") as handle:
                handle.write(data)
        except Exception as exc:
            self._file.record(exc, f"writing to {self._file.path}")

    def _encode(self, data: bytes) -> bytes:
        return gzip.compress(data, compresslevel=6) if self._gzip else data
