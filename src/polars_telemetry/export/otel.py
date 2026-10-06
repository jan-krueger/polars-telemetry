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

from polars_telemetry._version import __version__
from polars_telemetry.export import semconv
from polars_telemetry.export.attributes import query_attributes
from polars_telemetry.export.measurements import COUNTERS, HISTOGRAMS, measurements
from polars_telemetry.model.diagnostics import derive

if TYPE_CHECKING:
    from opentelemetry.metrics import Counter, Histogram

    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query

_MS_TO_NS = 1_000_000


class OTelExporter:
    """One span per query and per-node metrics, through OpenTelemetry.

    Uses the global tracer and meter providers, so the application's
    OpenTelemetry SDK decides where they go. Without an SDK installed, both are
    no-ops and nothing is sent.

    Args:
        config: Only `include_plan` is read from it, and `redaction` when
            `install()`'s config has none; every other option comes from the
            config given to `install()`.
    """

    __slots__ = ("_config", "_counters", "_histograms", "_meter", "_tracer")

    def __init__(self, config: Config) -> None:
        self._config = config
        self._tracer = trace.get_tracer("polars-telemetry", __version__)
        self._meter = metrics.get_meter("polars-telemetry", __version__)

        self._histograms: dict[str, Histogram] = {
            name: self._meter.create_histogram(name, unit=unit, description=desc)
            for name, unit, desc in HISTOGRAMS
        }
        self._counters: dict[str, Counter] = {
            name: self._meter.create_counter(name, unit=unit, description=desc)
            for name, unit, desc in COUNTERS
        }

    @property
    def config(self) -> Config:
        """The configuration this exporter was made with."""
        return self._config

    def export(self, query: Query) -> None:
        # Attached on arrival; derived here only for a Query built by hand.
        diagnostics = query.diagnostics or derive(query)
        shape = query.fingerprint

        start_ns = query.started_unix_ns or 0
        end_ns = start_ns + int(query.wall_ms * _MS_TO_NS)

        span = self._tracer.start_span(
            semconv.QUERY_SPAN,
            kind=SpanKind.INTERNAL,
            start_time=start_ns,
            attributes=query_attributes(
                query,
                diagnostics=diagnostics,
                plan_fingerprint=shape,
                include_plan=self._config.include_plan,
            ),
        )
        for finding in query.insights or ():
            span.add_event(
                semconv.INSIGHT_EVENT,
                attributes={
                    semconv.INSIGHT_RULE: finding.rule,
                    semconv.INSIGHT_LEVEL: finding.level,
                    semconv.NODE_KIND: finding.node_kind,
                    semconv.INSIGHT_TITLE: finding.title,
                    semconv.INSIGHT_FIX: finding.fix,
                    semconv.INSIGHT_EVIDENCE: " · ".join(map(str, finding.evidence)),
                    semconv.INSIGHT_CPU_SHARE: round(finding.impact.cpu_share, 4),
                    semconv.INSIGHT_BLOCKED_SHARE: round(finding.impact.blocked_share, 4),
                },
                timestamp=end_ns,
            )
        if query.failed:
            span.set_status(Status(StatusCode.ERROR, query.failed))
        else:
            span.set_status(Status(StatusCode.OK))
        span.end(end_time=end_ns)

        for m in measurements(query, diagnostics):
            if m.kind == "histogram":
                self._histograms[m.name].record(m.value, m.dims)
            else:
                self._counters[m.name].add(m.value, m.dims)
