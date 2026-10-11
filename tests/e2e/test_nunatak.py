"""HttpEventExporter against the nunatak binary."""

from __future__ import annotations

import gzip
import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config  # noqa: E402
from polars_telemetry.export.http_events import HttpEventExporter  # noqa: E402
from tests.unit.test_event_schema import EVENT, _problems  # noqa: E402

BINARY = Path(
    os.environ.get(
        "NUNATAK_BIN", Path(__file__).resolve().parents[2] / "nunatak/target/debug/nunatak"
    )
)

if not BINARY.exists():
    pytest.skip(f"no nunatak binary at {BINARY}", allow_module_level=True)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@pytest.fixture
def nunatak(tmp_path):
    port = _free_port()
    process = subprocess.Popen(  # noqa: S603
        [str(BINARY), "--bind", f"127.0.0.1:{port}", "--data", str(tmp_path)],
        env={**os.environ, "NUNATAK_TOKEN": "e2e-token"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 10
    while True:
        try:
            with urllib.request.urlopen(f"{url}/v1/health", timeout=1):  # noqa: S310
                break
        except OSError:
            assert time.monotonic() < deadline, "nunatak did not start"
            time.sleep(0.05)
    yield url, tmp_path
    process.terminate()
    process.wait(timeout=10)


def _slowly(df):
    time.sleep(0.6)
    return df


def test_a_query_sent_while_it_runs_is_kept_as_a_recording(nunatak):
    url, data = nunatak
    state = polars_telemetry.install(
        Config(progress_interval=0.1, insights=False),
        exporter=HttpEventExporter(url, token="e2e-token", service="e2e"),
    )
    assert state is not None
    try:
        with polars_telemetry.label("slow"):
            polars.LazyFrame({"a": list(range(1000))}).map_batches(_slowly).collect()
    finally:
        polars_telemetry.uninstall()

    stored = list((data / "recordings").rglob("*.jsonl.gz"))
    assert len(stored) == 1
    events = [json.loads(line) for line in gzip.decompress(stored[0].read_bytes()).splitlines()]
    kinds = [e["type"] for e in events]
    assert kinds[0] == "process"
    assert kinds[1] == "query.started"
    assert kinds[-1] == "query.finished"
    assert "query.progress" in kinds
    assert events[-1]["profile"]["label"] == "slow"
    assert [problem for event in events for problem in _problems(EVENT, event)] == []
    assert not list((data / "live").glob("*.jsonl"))
