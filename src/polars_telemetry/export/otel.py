"""OTel span and metric emission.

Depends on the OTel API only; the SDK and provider are the application's.

Spans are created after the query finishes, with explicit timestamps, so they
sit on the real timeline. Creation still happens on the calling thread inside
collect(), so the query span attaches to whatever trace context the caller had
active.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from opentelemetry import metrics, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from polars_telemetry import __version__
from polars_telemetry.export import semconv
from polars_telemetry.export.attributes import node_attributes
from polars_telemetry.model.windows import derive_windows

if TYPE_CHECKING:
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query

_MS_TO_NS = 1_000_000


class OTelExporter:
    """Query span, child span per node, per-node metric instruments."""

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
            attributes=self._query_attributes(query),
        )
        if query.failed:
            span.set_status(Status(StatusCode.ERROR, query.failed))
        else:
            span.set_status(Status(StatusCode.OK))

        if self._config.node_spans:
            self._emit_node_spans(query, span, start_ns, end_ns)

        span.end(end_time=end_ns)
        self._record_metrics(query)

    def _query_attributes(self, query: Query) -> dict[str, str | int | float]:
        attrs: dict[str, str | int | float] = {
            semconv.QUERY_ID: str(query.query_id),
            semconv.ENGINE: "streaming",
            semconv.CPU_MS: round(query.cpu_ms, 3),
            semconv.PARALLELISM: round(query.parallelism, 3),
            semconv.NODE_COUNT: len(query.plan),
        }
        if query.result_rows is not None:
            attrs[semconv.RESULT_ROWS] = query.result_rows
        if query.sample_interval_ms is not None:
            attrs[semconv.SAMPLE_RESOLUTION_MS] = query.sample_interval_ms
        return attrs

    def _emit_node_spans(
        self, query: Query, parent: trace.Span, start_ns: int, end_ns: int
    ) -> None:
        resolution = query.sample_interval_ms
        windows = derive_windows(query.samples, resolution) if resolution else {}
        if not windows:
            # Without at least two samples there is no window to span, and a
            # child span covering the whole query would be a fabrication.
            return

        final = query.final
        context = trace.set_span_in_context(parent)

        for node_id, window in sorted(windows.items(), key=lambda item: item[1].start_ms):
            node = query.plan.get(node_id)
            if node is None:
                continue
            attrs = node_attributes(node, redact_literals=self._config.redact_literals)
            attrs[semconv.NODE_ID] = node_id
            attrs[semconv.SAMPLE_RESOLUTION_MS] = window.resolution_ms
            if final is not None and node_id in final.nodes:
                metric = final.nodes[node_id]
                attrs[semconv.NODE_CPU_MS] = round(metric.total_time_ns / 1e6, 3)
                attrs[semconv.NODE_ROWS_IN] = metric.rows_received
                attrs[semconv.NODE_ROWS_OUT] = metric.rows_sent
                if metric.total_polls:
                    attrs[semconv.NODE_STOLEN_RATIO] = round(
                        metric.total_stolen_polls / metric.total_polls, 4
                    )

            child = self._tracer.start_span(
                node.kind,
                context=context,
                kind=SpanKind.INTERNAL,
                start_time=min(start_ns + int(window.start_ms * _MS_TO_NS), end_ns),
                attributes=attrs,
            )
            child.end(end_time=min(start_ns + int(window.end_ms * _MS_TO_NS), end_ns))

    def _record_metrics(self, query: Query) -> None:
        self._query_duration.record(query.wall_ms, {semconv.ENGINE: "streaming"})
        final = query.final
        if final is None:
            return
        for node_id, metric in final.nodes.items():
            node = query.plan.get(node_id)
            if node is None:
                continue
            # Bounded dimensions only; plan literals would wreck cardinality.
            dimensions = {semconv.NODE_KIND: node.kind, semconv.ENGINE: "streaming"}
            self._node_cpu.record(metric.total_time_ns / 1e6, dimensions)
            self._rows.add(metric.rows_sent, dimensions)
