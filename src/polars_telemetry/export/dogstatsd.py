"""Per-query and per-node metrics, sent as DogStatsD.

The same metrics as the OpenTelemetry exporter, through Datadog's own client,
so where they go, global tags, buffering and sending stay in that client's
configuration. Anything that reads DogStatsD with tags works: the Datadog
Agent, or Telegraf's statsd input on its way to InfluxDB.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Protocol

from polars_telemetry.export import semconv
from polars_telemetry.export.measurements import COUNTERS, HISTOGRAMS, measurements
from polars_telemetry.model.diagnostics import derive

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query

# Datadog's convention is short tag keys; the dimension names stay those of
# the OpenTelemetry metrics, so both describe the same thing.
DEFAULT_TAGS: Mapping[str, str] = {
    semconv.ENGINE: "engine",
    semconv.PLAN_FINGERPRINT: "fingerprint",
    semconv.NODE_KIND: "node_kind",
    semconv.DIRECTION: "direction",
    semconv.INSIGHT_RULE: "rule",
    semconv.INSIGHT_LEVEL: "level",
}


# How long close() waits for the client's sender to drain. It runs at exit,
# where waiting on a sender that has already stopped would hang the process.
CLOSE_TIMEOUT_S = 2.0


class StatsdClient(Protocol):
    """What the exporter uses of `datadog.DogStatsd`."""

    def distribution(self, metric: str, value: float, tags: list[str]) -> None: ...
    def histogram(self, metric: str, value: float, tags: list[str]) -> None: ...
    def increment(self, metric: str, value: float, tags: list[str]) -> None: ...
    def flush(self) -> None: ...


class DogStatsdExporter:
    """Per-query and per-node metrics as DogStatsD, with tags.

    Totals are sent as counts; times and ratios as distributions, or as
    histograms with `distributions=False`.

    Args:
        client: A `datadog.DogStatsd`. Defaults to `datadog.statsd`, the client
            `datadog.initialize()` configures. Turn on its buffering and
            background sender, so sending happens off the query's thread.
        metric_names: Renames metrics, from their names in
            [Spans and metrics](../reference/spans-and-metrics.md). A mapping
            or a function; a name mapped to None is not sent.
        tag_names: Renames tag keys: `engine`, `fingerprint`, `node_kind`,
            `direction`, `rule` and `level`. A key mapped to None is not sent, such as
            `{"fingerprint": None}` to keep one series per query shape off a
            bill.
        tag_labels: Also tag every metric with the query's label. Labels are
            free-form, so only do this when yours come from a small, fixed set.
        distributions: Send times and ratios as distributions (`|d`), which
            Datadog aggregates across hosts. False sends histograms (`|h`),
            which Telegraf summarises per flush; Telegraf keeps only one
            sample of a distribution per flush.
    """

    __slots__ = ("_client", "_distributions", "_metric_name", "_tag_key", "_tag_labels")

    def __init__(
        self,
        client: StatsdClient | None = None,
        *,
        metric_names: Mapping[str, str | None] | Callable[[str], str | None] | None = None,
        tag_names: Mapping[str, str | None] | None = None,
        tag_labels: bool = False,
        distributions: bool = True,
    ) -> None:
        if client is None:
            try:
                from datadog.dogstatsd.base import statsd
            except ImportError as exc:
                msg = (
                    "DogStatsdExporter needs the datadog package: "
                    "pip install 'polars-telemetry[datadog]'"
                )
                raise ImportError(msg) from exc
            client = statsd
        self._client: StatsdClient = client
        self._tag_labels = tag_labels
        self._distributions = distributions

        if metric_names is None:
            self._metric_name: Callable[[str], str | None] = lambda name: name
        elif callable(metric_names):
            self._metric_name = metric_names
        else:
            renames = dict(metric_names)
            _reject_unknown("metric", renames, {name for name, _, _ in (*HISTOGRAMS, *COUNTERS)})
            self._metric_name = lambda name: renames.get(name, name)

        renamed = dict(tag_names or {})
        _reject_unknown("tag", renamed, set(DEFAULT_TAGS.values()))
        self._tag_key: dict[str, str | None] = {
            dim: renamed.get(short, short) for dim, short in DEFAULT_TAGS.items()
        }

    def export(self, query: Query) -> None:
        diagnostics = query.diagnostics or derive(query)
        label = [f"label:{query.label}"] if self._tag_labels and query.label else []
        for m in measurements(query, diagnostics):
            name = self._metric_name(m.name)
            if name is None:
                continue
            tags = [*self._tags(m.dims), *label]
            if m.kind == "histogram" and self._distributions:
                self._client.distribution(name, m.value, tags=tags)
            elif m.kind == "histogram":
                self._client.histogram(name, m.value, tags=tags)
            else:
                self._client.increment(name, m.value, tags=tags)

    def close(self) -> None:
        """Send what the client still holds. Called by `uninstall()` and at exit."""
        self._client.flush()
        # Only with the background sender; flush() sends directly otherwise.
        wait = getattr(self._client, "wait_for_pending", None)
        if wait is not None:
            wait(timeout=CLOSE_TIMEOUT_S)

    def _tags(self, dims: dict[str, str]) -> list[str]:
        tags = []
        for dim, value in dims.items():
            key = self._tag_key.get(dim, dim)
            if key is not None:
                tags.append(f"{key}:{value}")
        return tags


def _reject_unknown(what: str, given: Mapping[str, object], known: set[str]) -> None:
    # A misspelt name would otherwise change nothing, silently.
    unknown = sorted(set(given) - known)
    if unknown:
        msg = f"unknown {what} names {unknown}; known: {sorted(known)}"
        raise ValueError(msg)
