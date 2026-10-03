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
from polars_telemetry.export.attributes import query_attributes, redact
from polars_telemetry.model.diagnostics import derive
from polars_telemetry.model.fingerprint import fingerprint

if TYPE_CHECKING:
    from opentelemetry.metrics import Counter, Histogram

    from polars_telemetry.config import Config
    from polars_telemetry.model.diagnostics import Diagnostics
    from polars_telemetry.model.types import Query

_MS_TO_NS = 1_000_000


class OTelExporter:
    """A query span, plus per-node metric instruments."""

    __slots__ = ("_config", "_counters", "_histograms", "_meter", "_tracer")

    def __init__(self, config: Config) -> None:
        self._config = config
        self._tracer = trace.get_tracer("polars-telemetry", __version__)
        self._meter = metrics.get_meter("polars-telemetry", __version__)

        self._histograms: dict[str, Histogram] = {
            name: self._meter.create_histogram(name, unit=unit, description=desc)
            for name, unit, desc in (
                (semconv.QUERY_DURATION, "ms", "Wall time per query"),
                (semconv.QUERY_CPU_TIME, "ms", "Summed node self time per query"),
                (semconv.QUERY_PARALLEL_EFFICIENCY, "1", "CPU time over wall time over cores"),
                (semconv.NODE_CPU_TIME, "ms", "Self time per plan node"),
                (semconv.NODE_POLL_TIME, "ms", "Time a node spent being polled"),
                (semconv.NODE_MAX_POLL_TIME, "ms", "Longest single poll of a node"),
                (semconv.NODE_STATE_UPDATE_TIME, "ms", "Time a node spent in state updates"),
                (
                    semconv.NODE_MAX_STATE_UPDATE_TIME,
                    "ms",
                    "Longest single state update of a node",
                ),
                (semconv.NODE_LARGEST_MORSEL, "{row}", "Largest morsel a node received"),
                (semconv.NODE_STOLEN_RATIO, "1", "Share of a node's polls that were stolen"),
                (semconv.NODE_IO_TIME, "ms", "Time a node spent active on IO"),
            )
        }
        self._counters: dict[str, Counter] = {
            name: self._meter.create_counter(name, unit=unit, description=desc)
            for name, unit, desc in (
                (semconv.NODE_ROWS_IN, "{row}", "Rows received by a plan node"),
                (semconv.NODE_ROWS_OUT, "{row}", "Rows emitted by a plan node"),
                (semconv.NODE_MORSELS_IN, "{morsel}", "Morsels received by a plan node"),
                (semconv.NODE_MORSELS_OUT, "{morsel}", "Morsels emitted by a plan node"),
                (semconv.NODE_POLLS, "{poll}", "Times a node was polled"),
                (semconv.NODE_STATE_UPDATES, "{update}", "State updates on a node"),
                (semconv.NODE_IO_BYTES, "By", "Bytes moved by a node"),
            )
        }

    def export(self, query: Query) -> None:
        diagnostics = derive(query)
        shape = fingerprint(query.logical or query.plan)

        start_ns = query.started_unix_ns or 0
        end_ns = start_ns + int(query.wall_ms * _MS_TO_NS)

        span = self._tracer.start_span(
            semconv.QUERY_SPAN,
            kind=SpanKind.INTERNAL,
            start_time=start_ns,
            attributes=query_attributes(
                query,
                redact_literals=self._config.redact_literals,
                diagnostics=diagnostics,
                plan_fingerprint=shape,
                include_plan=self._config.include_plan,
            ),
        )
        if query.failed:
            # polars' failure text quotes the offending values.
            message = redact(query.failed) if self._config.redact_literals else query.failed
            span.set_status(Status(StatusCode.ERROR, message))
        else:
            span.set_status(Status(StatusCode.OK))
        span.end(end_time=end_ns)

        self._record_query(query, diagnostics, shape)
        self._record_nodes(query)

    def _record_query(self, query: Query, diagnostics: Diagnostics, shape: str) -> None:
        dims = {semconv.ENGINE: "streaming", semconv.PLAN_FINGERPRINT: shape}
        self._histograms[semconv.QUERY_DURATION].record(query.wall_ms, dims)
        if query.metrics:
            self._histograms[semconv.QUERY_CPU_TIME].record(query.cpu_ms, dims)
        if diagnostics.parallel_efficiency is not None:
            self._histograms[semconv.QUERY_PARALLEL_EFFICIENCY].record(
                diagnostics.parallel_efficiency, dims
            )

    def _record_nodes(self, query: Query) -> None:
        for node_id, metric in query.metrics.items():
            node = query.plan.get(node_id)
            if node is None:
                continue
            # Bounded dimensions only; plan literals would wreck cardinality.
            dims = {semconv.NODE_KIND: node.kind, semconv.ENGINE: "streaming"}

            self._histograms[semconv.NODE_CPU_TIME].record(metric.cpu_ms, dims)
            self._histograms[semconv.NODE_MAX_POLL_TIME].record(metric.max_poll_time_ns / 1e6, dims)
            for direction, largest in (
                ("received", metric.largest_morsel_received),
                ("sent", metric.largest_morsel_sent),
            ):
                if largest:
                    self._histograms[semconv.NODE_LARGEST_MORSEL].record(
                        largest, {**dims, semconv.DIRECTION: direction}
                    )
            if metric.stolen_ratio is not None:
                self._histograms[semconv.NODE_STOLEN_RATIO].record(metric.stolen_ratio, dims)
            if metric.io_total_active_ns:
                self._histograms[semconv.NODE_IO_TIME].record(metric.io_total_active_ns / 1e6, dims)

            self._counters[semconv.NODE_ROWS_IN].add(metric.rows_received, dims)
            self._counters[semconv.NODE_ROWS_OUT].add(metric.rows_sent, dims)
            self._counters[semconv.NODE_MORSELS_IN].add(metric.morsels_received, dims)
            self._counters[semconv.NODE_MORSELS_OUT].add(metric.morsels_sent, dims)
            self._counters[semconv.NODE_POLLS].add(metric.total_polls, dims)
            self._counters[semconv.NODE_STATE_UPDATES].add(metric.total_state_updates, dims)

            for direction, value in (
                ("requested", metric.io_total_bytes_requested),
                ("received", metric.io_total_bytes_received),
                ("sent", metric.io_total_bytes_sent),
            ):
                if value:
                    self._counters[semconv.NODE_IO_BYTES].add(
                        value, {**dims, semconv.DIRECTION: direction}
                    )
