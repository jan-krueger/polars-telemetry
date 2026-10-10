"""Send what happens to each query, while it runs, to a server over HTTP.

The same events `FileEventExporter` writes, `polars-telemetry/events@1`, posted
to `{url}/v1/events` as gzip-compressed JSON Lines, each request starting with the
process line. Sending happens on one background thread, so a slow or unreachable
server never delays a query.
"""

from __future__ import annotations

import gzip
import http.client
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from polars_telemetry.export.events import Stream, finished_event, progress_event, started_event

if TYPE_CHECKING:
    from polars_telemetry.model.types import Progress, Query

_log = logging.getLogger("polars_telemetry")

DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024

_BATCH_BYTES = 256 * 1024
_BATCH_SECONDS = 2.0
_REQUEST_BYTES = 4 * 1024 * 1024
_RETRY_FOR = 600.0
_BACKOFF_FIRST = 0.5
_BACKOFF_MAX = 30.0
_CLOSE_WAIT = 2.0


@dataclass(slots=True)
class _Pending:
    line: str
    droppable: bool
    queued_at: float


class HttpEventExporter:
    """Send the life of every query to a server that receives `polars-telemetry/events@1`.

    Args:
        url: The server, such as `"http://localhost:7766"`. Events go to
            `{url}/v1/events`.
        token: Sent as `Authorization: Bearer <token>`.
        service: What the process is, such as `"orders-etl"`.
        environment: Where it runs, such as `"prod"`.
        max_queue_bytes: 16 MiB by default. Events waiting to be sent beyond this
            are dropped, progress samples first.
        timeout: Seconds to wait for the server on each request.
    """

    def __init__(
        self,
        url: str,
        *,
        token: str,
        service: str | None = None,
        environment: str | None = None,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        timeout: float = 10.0,
    ) -> None:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            msg = f"url must be http:// or https:// with a host, got {url!r}"
            raise ValueError(msg)
        if max_queue_bytes <= 0:
            msg = f"max_queue_bytes must be positive, got {max_queue_bytes}"
            raise ValueError(msg)
        self.url = url
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._path = parts.path.rstrip("/") + "/v1/events"
        self._token = token
        self._timeout = timeout
        self._max_queue_bytes = max_queue_bytes
        self._stream = Stream(service, environment)
        self._process = self._stream.process()
        self._cond = threading.Condition()
        self._queue: deque[_Pending] = deque()
        self._queued = 0
        self._due = False
        self._closing = False
        self._refused = False
        self._thread: threading.Thread | None = None
        self._connection: http.client.HTTPConnection | None = None
        self._warned: set[str] = set()
        self.errors = 0
        """How many requests have failed."""
        self.dropped = 0
        """How many events were dropped without being sent."""

    def started(self, query: Query) -> None:
        self._enqueue(started_event(query), urgent=True, droppable=False)

    def progress(self, progress: Progress) -> None:
        self._enqueue(progress_event(progress), urgent=False, droppable=True)

    def export(self, query: Query) -> None:
        self._enqueue(finished_event(query), urgent=True, droppable=False)

    def close(self) -> None:
        """Send what is queued, for at most two seconds. Called by `uninstall()` and at exit."""
        with self._cond:
            self._closing = True
            self._due = True
            self._cond.notify_all()
            thread = self._thread
        if thread is not None:
            thread.join(_CLOSE_WAIT)

    def _enqueue(self, event: dict[str, Any], *, urgent: bool, droppable: bool) -> None:
        with self._cond:
            if self._refused:
                return
            try:
                line = self._stream.line(event)
            except Exception as exc:
                self._warn("event", "building an event", exc)
                return
            self._queue.append(_Pending(line, droppable, time.monotonic()))
            self._queued += len(line) + 1
            self._bound()
            if urgent or self._closing or self._queued >= _BATCH_BYTES:
                self._due = True
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._run, name="polars-telemetry-http-events", daemon=True
                )
                self._thread.start()
            self._cond.notify_all()

    def _bound(self) -> None:
        while self._queued > self._max_queue_bytes and self._queue:
            victim = next((p for p in self._queue if p.droppable), self._queue[0])
            self._queue.remove(victim)
            self._queued -= len(victim.line) + 1
            self.dropped += 1

    def _run(self) -> None:
        backoff = _BACKOFF_FIRST
        while True:
            batch = self._next_batch()
            if batch is None:
                return
            outcome, retry_after = self._send(batch)
            if outcome == "retry":
                self._requeue(batch)
                with self._cond:
                    if self._closing:
                        self._drop_all()
                        return
                    self._cond.wait(retry_after if retry_after is not None else backoff)
                backoff = min(backoff * 2, _BACKOFF_MAX)
            else:
                backoff = _BACKOFF_FIRST

    def _next_batch(self) -> list[_Pending] | None:
        with self._cond:
            while True:
                if self._refused or (self._closing and not self._queue):
                    return None
                if self._queue:
                    wait = self._queue[0].queued_at + _BATCH_SECONDS - time.monotonic()
                    if self._due or wait <= 0:
                        break
                    self._cond.wait(wait)
                else:
                    self._cond.wait()
            batch: list[_Pending] = []
            size = 0
            while self._queue and (not batch or size + len(self._queue[0].line) < _REQUEST_BYTES):
                pending = self._queue.popleft()
                batch.append(pending)
                size += len(pending.line) + 1
            self._queued -= size
            self._due = bool(self._queue) and self._due
            return batch

    def _requeue(self, batch: list[_Pending]) -> None:
        oldest = time.monotonic() - _RETRY_FOR
        kept = [p for p in batch if p.queued_at >= oldest]
        with self._cond:
            self.dropped += len(batch) - len(kept)
            self._queue.extendleft(reversed(kept))
            self._queued += sum(len(p.line) + 1 for p in kept)
            self._due = True
            self._bound()

    def _drop_all(self) -> None:
        self.dropped += len(self._queue)
        self._queue.clear()
        self._queued = 0

    def _send(self, batch: list[_Pending]) -> tuple[str, float | None]:
        body = gzip.compress(
            ("\n".join([self._process, *(p.line for p in batch)]) + "\n").encode("utf-8"),
            compresslevel=6,
        )
        try:
            status, headers = self._post(body)
        except (OSError, http.client.HTTPException) as exc:
            self._reset()
            self.errors += 1
            self._warn("network", f"sending to {self.url}", exc)
            return "retry", None
        if 200 <= status < 300:
            return "sent", None
        self.errors += 1
        if status in {401, 403}:
            with self._cond:
                self._refused = True
                self.dropped += len(batch)
                self._drop_all()
            self._warn(
                "token", f"sending to {self.url}", f"the server refused the token ({status})"
            )
            return "refused", None
        if status == 413 and len(batch) > 1:
            half = len(batch) // 2
            first, _ = self._send(batch[:half])
            second, _ = self._send(batch[half:])
            return ("retry" if "retry" in {first, second} else "sent"), None
        if status in {429, 503} or status >= 500:
            self._warn(
                "server", f"sending to {self.url}", f"the server answered {status}; retrying"
            )
            return "retry", _retry_after(headers.get("Retry-After"))
        self.dropped += len(batch)
        self._warn("batch", f"sending to {self.url}", f"the server rejected a batch ({status})")
        return "rejected", None

    def _post(self, body: bytes) -> tuple[int, http.client.HTTPMessage]:
        if self._connection is None:
            kind = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
            self._connection = kind(self._host, self._port, timeout=self._timeout)
        self._connection.request(
            "POST",
            self._path,
            body=body,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/x-ndjson",
                "Content-Encoding": "gzip",
            },
        )
        response = self._connection.getresponse()
        response.read()
        return response.status, response.headers

    def _reset(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def _warn(self, kind: str, doing: str, problem: object) -> None:
        if kind in self._warned:
            return
        self._warned.add(kind)
        _log.warning(
            "polars-telemetry: event export failed while %s (%s). Queries are unaffected.",
            doing,
            problem,
        )


def _retry_after(value: str | None) -> float | None:
    try:
        return min(max(float(value), 0.0), _BACKOFF_MAX) if value is not None else None
    except ValueError:
        return None
