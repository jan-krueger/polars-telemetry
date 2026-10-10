"""Sending events to a server, against a stub that records each request."""

from __future__ import annotations

import gzip
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from polars_telemetry.export import http_events
from polars_telemetry.export.http_events import HttpEventExporter
from tests.unit.test_event_exporter import _progress, _query
from tests.unit.test_event_schema import EVENT, _problems


class Stub:
    """A server that answers each request with the next scripted status, 202 once they run out."""

    def __init__(self, *statuses: int | tuple[int, dict[str, str]]) -> None:
        self.statuses = list(statuses)
        self.requests: list[dict[str, Any]] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["Content-Length"]))
                lines = gzip.decompress(body).decode().splitlines()
                stub.requests.append(
                    {
                        "path": self.path,
                        "headers": dict(self.headers),
                        "events": [json.loads(line) for line in lines],
                    }
                )
                answer = stub.statuses.pop(0) if stub.statuses else 202
                status, headers = answer if isinstance(answer, tuple) else (answer, {})
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, args=(0.02,), daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def events(self) -> list[dict[str, Any]]:
        return [event for request in self.requests for event in request["events"]]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stub():
    servers: list[Stub] = []

    def start(*statuses: int | tuple[int, dict[str, str]]) -> Stub:
        servers.append(Stub(*statuses))
        return servers[-1]

    yield start
    for server in servers:
        server.close()


def _until(condition, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def test_a_query_is_sent_as_one_stream_of_valid_events(stub):
    server = stub()
    exporter = HttpEventExporter(server.url, token="s3cret", service="orders-etl")
    query = _query()
    exporter.started(query)
    exporter.progress(_progress(query, 2))
    exporter.export(query)
    exporter.close()

    first = server.requests[0]
    assert first["path"] == "/v1/events"
    assert first["headers"]["Authorization"] == "Bearer s3cret"
    assert first["headers"]["Content-Encoding"] == "gzip"
    assert first["headers"]["Content-Type"] == "application/x-ndjson"
    assert all(request["events"][0]["type"] == "process" for request in server.requests)
    sent = [e for e in server.events() if e["type"] != "process"]
    assert [e["type"] for e in sent] == ["query.started", "query.progress", "query.finished"]
    assert [problem for e in server.events() for problem in _problems(EVENT, e)] == []


def test_a_url_with_a_path_keeps_it(stub):
    server = stub()
    exporter = HttpEventExporter(f"{server.url}/nunatak/", token="t")
    exporter.export(_query())
    exporter.close()
    assert server.requests[0]["path"] == "/nunatak/v1/events"


def test_progress_waits_for_a_batch_and_goes_out_within_its_window(stub, monkeypatch):
    monkeypatch.setattr(http_events, "_BATCH_SECONDS", 0.2)
    server = stub()
    exporter = HttpEventExporter(server.url, token="t")
    exporter.progress(_progress(_query(), 2))
    time.sleep(0.05)
    assert server.requests == []
    _until(lambda: len(server.requests) == 1)
    exporter.close()


def test_a_busy_server_gets_the_same_events_again(stub):
    server = stub((503, {"Retry-After": "0"}))
    exporter = HttpEventExporter(server.url, token="t")
    exporter.export(_query())
    _until(lambda: len(server.requests) == 2)
    exporter.close()
    first, second = (request["events"] for request in server.requests)
    assert [(e["type"], e["seq"]) for e in first] == [(e["type"], e["seq"]) for e in second]
    assert exporter.errors == 1


def test_a_refused_token_stops_sending_and_warns_once(stub, caplog):
    server = stub(401)
    exporter = HttpEventExporter(server.url, token="wrong")
    with caplog.at_level(logging.WARNING, logger="polars_telemetry"):
        exporter.export(_query())
        _until(lambda: len(server.requests) == 1)
        _until(lambda: exporter.dropped == 1)
        exporter.export(_query())
        exporter.close()
    assert len(server.requests) == 1
    assert "refused the token (401)" in caplog.text
    assert caplog.text.count("polars-telemetry: event export failed") == 1


def test_each_kind_of_problem_is_warned_about_once(stub, caplog):
    server = stub((503, {"Retry-After": "0"}), (503, {"Retry-After": "0"}), 401)
    exporter = HttpEventExporter(server.url, token="t")
    with caplog.at_level(logging.WARNING, logger="polars_telemetry"):
        exporter.export(_query())
        _until(lambda: len(server.requests) == 3)
        exporter.close()
    assert caplog.text.count("answered 503") == 1
    assert caplog.text.count("refused the token") == 1


def test_a_batch_too_large_is_split(stub):
    server = stub(413)
    exporter = HttpEventExporter(server.url, token="t")
    query = _query()
    exporter.progress(_progress(query, 1))
    exporter.progress(_progress(query, 2))
    exporter.export(query)
    exporter.close()
    assert len(server.requests[0]["events"]) == 4
    sent = [e["seq"] for request in server.requests[1:] for e in request["events"][1:]]
    assert sorted(sent) == [e["seq"] for e in server.requests[0]["events"][1:]]


def test_a_full_queue_drops_progress_before_anything_else(monkeypatch):
    monkeypatch.setattr(HttpEventExporter, "_run", lambda self: None)
    exporter = HttpEventExporter("http://127.0.0.1:9", token="t", max_queue_bytes=4_000)
    query = _query()
    exporter.started(query)
    for rows in range(40):
        exporter.progress(_progress(query, rows))
    exporter.export(query)
    kinds = [json.loads(p.line)["type"] for p in exporter._queue]
    assert kinds[0] == "query.started"
    assert kinds[-1] == "query.finished"
    assert exporter.dropped > 0


def test_closing_against_a_server_that_is_down_gives_up_quickly():
    exporter = HttpEventExporter("http://127.0.0.1:9", token="t", timeout=1.0)
    exporter.export(_query())
    began = time.monotonic()
    exporter.close()
    assert time.monotonic() - began < 3.0


@pytest.mark.parametrize("url", ["localhost:7766", "ftp://host/x", "http://"])
def test_the_url_must_be_http_with_a_host(url):
    with pytest.raises(ValueError, match="http"):
        HttpEventExporter(url, token="t")
