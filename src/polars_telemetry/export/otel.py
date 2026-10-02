"""OTel span and metric emission.

Depends on the OTel API only; the SDK and provider are the application's.

One span per query, no child spans: polars reports cumulative counters with no
per-node timestamps, so node intervals would have to be sampled, and sampling
measured at 5-15% overhead while collapsing most nodes onto identical windows.
Node detail is exact when read once at the end, and is carried as metrics and
query-span aggregates instead.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from opentelemetry import metrics, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from polars_telemetry import __version__
from polars_telemetry.export import semconv
from polars_telemetry.export.attributes import query_attributes

if TYPE_CHECKING:
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query

_MS_TO_NS = 1_000_000


class OTelExporter:
    """A query span, plus per-node metric instruments."""

    __slots__ = ("_config", "_meter", "_node_cpu", "_query_duration", "_rows", "_tracer")

    def __init__(self, config: Config) -> None:
        self._config = config
        self._tracer = trace.get_tracer("polars-telemetry", __version__)
        self._meter = metrics.get_meter("polars-telemetry", __version__)
        self._query_duration = self._meter.create_histogram(
            "polars.query.duration", unit="ms", description="Wall time per polars query"
        )
        self._node_cpu = self._meter.create_histogram(
            "polars.node.cpu_time", unit="ms", description="Self time per plan node"
        )
        self._rows = self._meter.create_counter(
            "polars.node.rows", description="Rows emitted by a plan node"
        )

    def export(self, query: Query) -> None:
        start_ns = query.started_unix_ns or 0
        end_ns = start_ns + int(query.wall_ms * _MS_TO_NS)

        span = self._tracer.start_span(
            semconv.QUERY_SPAN,
            kind=SpanKind.INTERNAL,
            start_time=start_ns,
            attributes=query_attributes(query, redact_literals=self._config.redact_literals),
        )
        if query.failed:
            span.set_status(Status(StatusCode.ERROR, query.failed))
        else:
            span.set_status(Status(StatusCode.OK))
        span.end(end_time=end_ns)

        self._record_metrics(query)

    def _record_metrics(self, query: Query) -> None:
        self._query_duration.record(query.wall_ms, {semconv.ENGINE: "streaming"})
        for node_id, metric in query.metrics.items():
            node = query.plan.get(node_id)
            if node is None:
                continue
            # Bounded dimensions only; plan literals would wreck cardinality.
            dimensions = {semconv.NODE_KIND: node.kind, semconv.ENGINE: "streaming"}
            self._node_cpu.record(metric.cpu_ms, dimensions)
            self._rows.add(metric.rows_sent, dimensions)
