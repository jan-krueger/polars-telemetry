"""The metrics every metrics exporter sends, and their values for one query.

One definition, so the OpenTelemetry and DogStatsD exporters cannot drift
apart in what they report or how they derive it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from polars_telemetry.export import semconv

if TYPE_CHECKING:
    from collections.abc import Iterator

    from polars_telemetry.model.diagnostics import Diagnostics
    from polars_telemetry.model.types import Query

# The instrument registry: name, unit, description. Units are public API --
# an OTLP-to-Prometheus translator derives the series suffix from them --
# so they are declared here and checked against the attribute reference.
HISTOGRAMS: Final[tuple[tuple[str, str, str], ...]] = (
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

COUNTERS: Final[tuple[tuple[str, str, str], ...]] = (
    (semconv.NODE_ROWS_IN, "{row}", "Rows received by a plan node"),
    (semconv.NODE_ROWS_OUT, "{row}", "Rows emitted by a plan node"),
    (semconv.NODE_MORSELS_IN, "{morsel}", "Morsels received by a plan node"),
    (semconv.NODE_MORSELS_OUT, "{morsel}", "Morsels emitted by a plan node"),
    (semconv.NODE_POLLS, "{poll}", "Times a node was polled"),
    (semconv.NODE_STATE_UPDATES, "{update}", "State updates on a node"),
    (semconv.NODE_IO_BYTES, "By", "Bytes moved by a node"),
    (semconv.QUERY_INSIGHTS, "{finding}", "Findings about query plans, by rule and level"),
)


@dataclass(frozen=True, slots=True)
class Measurement:
    """One value for one metric, with its dimensions."""

    name: str
    kind: Literal["histogram", "counter"]
    value: float
    dims: dict[str, str]


def measurements(query: Query, diagnostics: Diagnostics) -> Iterator[Measurement]:
    """Every metric value a query yields. Dimensions come from bounded sets only;
    plan literals would wreck cardinality.

    Counters are summed per metric and dimensions before they are yielded: a
    counter only ever adds, so two GroupBy nodes reporting 10 and 5 rows are
    the same 15 to any backend, in one call instead of two. Histograms keep one
    value per node, since merging them would change their percentiles.
    """
    engine = query.engine or "unknown"
    totals: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}

    def histogram(name: str, value: float, dims: dict[str, str]) -> Measurement:
        return Measurement(name, "histogram", value, dims)

    def counter(name: str, value: float, dims: dict[str, str]) -> None:
        key = (name, tuple(dims.items()))
        totals[key] = totals.get(key, 0) + value

    shape = {semconv.ENGINE: engine, semconv.PLAN_FINGERPRINT: query.fingerprint}
    yield histogram(semconv.QUERY_DURATION, query.wall_ms, shape)
    if query.metrics:
        yield histogram(semconv.QUERY_CPU_TIME, query.cpu_ms, shape)
    if diagnostics.parallel_efficiency is not None:
        yield histogram(semconv.QUERY_PARALLEL_EFFICIENCY, diagnostics.parallel_efficiency, shape)

    for node_id, metric in query.metrics.items():
        node = query.plan.get(node_id)
        if node is None:
            continue
        dims = {semconv.NODE_KIND: node.kind, semconv.ENGINE: engine}

        yield histogram(semconv.NODE_CPU_TIME, metric.cpu_ms, dims)
        yield histogram(semconv.NODE_POLL_TIME, metric.total_poll_time_ns / 1e6, dims)
        yield histogram(semconv.NODE_MAX_POLL_TIME, metric.max_poll_time_ns / 1e6, dims)
        yield histogram(
            semconv.NODE_STATE_UPDATE_TIME, metric.total_state_update_time_ns / 1e6, dims
        )
        yield histogram(
            semconv.NODE_MAX_STATE_UPDATE_TIME, metric.max_state_update_time_ns / 1e6, dims
        )
        for direction, largest in (
            ("received", metric.largest_morsel_received),
            ("sent", metric.largest_morsel_sent),
        ):
            if largest:
                yield histogram(
                    semconv.NODE_LARGEST_MORSEL, largest, {**dims, semconv.DIRECTION: direction}
                )
        if metric.stolen_ratio is not None:
            yield histogram(semconv.NODE_STOLEN_RATIO, metric.stolen_ratio, dims)
        if metric.io_total_active_ns:
            yield histogram(semconv.NODE_IO_TIME, metric.io_total_active_ns / 1e6, dims)

        counter(semconv.NODE_ROWS_IN, metric.rows_received, dims)
        counter(semconv.NODE_ROWS_OUT, metric.rows_sent, dims)
        counter(semconv.NODE_MORSELS_IN, metric.morsels_received, dims)
        counter(semconv.NODE_MORSELS_OUT, metric.morsels_sent, dims)
        counter(semconv.NODE_POLLS, metric.total_polls, dims)
        counter(semconv.NODE_STATE_UPDATES, metric.total_state_updates, dims)
        for direction, value in (
            ("requested", metric.io_total_bytes_requested),
            ("received", metric.io_total_bytes_received),
            ("sent", metric.io_total_bytes_sent),
        ):
            if value:
                counter(semconv.NODE_IO_BYTES, value, {**dims, semconv.DIRECTION: direction})

    for finding in query.insights or ():
        if finding.kind == "problem":
            counter(
                semconv.QUERY_INSIGHTS,
                1,
                {
                    semconv.PLAN_FINGERPRINT: query.fingerprint,
                    semconv.INSIGHT_RULE: finding.rule,
                    semconv.INSIGHT_LEVEL: finding.level,
                },
            )

    for (name, tags), total in totals.items():
        yield Measurement(name, "counter", total, dict(tags))
