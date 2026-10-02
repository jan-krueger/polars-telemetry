"""Export to a real OTel collector.

Run the stack first: `docker compose -f docker/compose.yaml up -d --wait`.
Skipped when nothing is listening, so a plain `pytest` still works.
"""

from __future__ import annotations

import os
import socket
from urllib.parse import urlparse

import pytest

pytestmark = [pytest.mark.integration]

polars = pytest.importorskip("polars")
pytest.importorskip("opentelemetry.exporter.otlp.proto.grpc.trace_exporter")

from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (  # noqa: E402
    OTLPSpanExporter,
)
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402

import polars_telemetry  # noqa: E402
from polars_telemetry import Config  # noqa: E402
from polars_telemetry.export.otel import OTelExporter  # noqa: E402

ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")


def _reachable(endpoint: str) -> bool:
    parsed = urlparse(endpoint)
    host, port = parsed.hostname or "localhost", parsed.port or 4317
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


pytestmark.append(
    pytest.mark.skipif(not _reachable(ENDPOINT), reason=f"no collector at {ENDPOINT}")
)


@pytest.fixture
def provider():
    provider = TracerProvider(resource=Resource.create({"service.name": "polars-telemetry-tests"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=ENDPOINT)))
    yield provider
    provider.shutdown()


def test_spans_reach_the_collector(provider, monkeypatch):
    """Exercises the wire format, which in-memory exporters never check."""
    from opentelemetry import trace

    monkeypatch.setattr(trace, "get_tracer_provider", lambda: provider)

    config = Config()
    polars_telemetry.install(config, exporter=OTelExporter(config))
    try:
        (
            polars.DataFrame({"a": list(range(50_000)), "b": ["x", "y"] * 25_000})
            .lazy()
            .filter(polars.col("a") > 10)
            .group_by("b")
            .agg(polars.col("a").sum())
            .collect()
        )
    finally:
        polars_telemetry.uninstall()

    assert provider.force_flush(timeout_millis=10_000), "collector did not accept the spans"
