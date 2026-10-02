"""Sample workload for the local stack.

Runs a few ETL-shaped jobs, each inside its own application span, so the polars
span nests underneath and the metrics have something to show.

    docker compose -f docker/compose.yaml up -d --wait
    uv run python examples/workload.py
"""

from __future__ import annotations

import random
import time

import polars as pl
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

import polars_telemetry

ENDPOINT = "http://localhost:4317"
DURATION_S = 60
ROWS = 2_000_000


def _telemetry() -> tuple[TracerProvider, MeterProvider]:
    resource = Resource.create({"service.name": "orders-etl", "deployment.environment": "local"})
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=ENDPOINT, insecure=True))
    )
    trace.set_tracer_provider(tracer_provider)

    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[
            PeriodicExportingMetricReader(
                OTLPMetricExporter(endpoint=ENDPOINT, insecure=True),
                export_interval_millis=2000,
            )
        ],
    )
    metrics.set_meter_provider(meter_provider)
    return tracer_provider, meter_provider


def main() -> None:
    tracer_provider, meter_provider = _telemetry()
    state = polars_telemetry.install()
    if state is None:
        raise SystemExit("polars-telemetry could not instrument this polars")
    print(f"polars {state.capabilities.polars_version}; sending to {ENDPOINT}")

    tracer = trace.get_tracer("orders-etl")
    orders = pl.DataFrame(
        {
            "cid": [i % 5000 for i in range(ROWS)],
            "amount": [float(i % 97) for i in range(ROWS)],
            "qty": [(i % 5) + 1 for i in range(ROWS)],
            "region_id": [i % 8 for i in range(ROWS)],
        }
    )
    customers = pl.DataFrame(
        {"cid": list(range(5000)), "seg": ["enterprise", "midmarket", "smb", "partner"] * 1250}
    )
    regions = pl.DataFrame(
        {
            "region_id": list(range(8)),
            "region": ["emea", "apac", "namer", "latam", "anz", "mena", "sea", "nordics"],
        }
    )
    orders.write_parquet("orders.parquet")

    def revenue_report(threshold: float) -> pl.DataFrame:
        return (
            pl.scan_parquet("orders.parquet")
            .filter(pl.col("amount") > threshold)
            .join(customers.lazy(), on="cid", how="inner")
            .join(regions.lazy(), on="region_id", how="inner")
            .with_columns((pl.col("amount") * pl.col("qty")).alias("revenue"))
            .group_by("region", "seg")
            .agg(pl.col("revenue").sum())
            .sort("revenue", descending=True)
            .collect()
        )

    def top_customers(threshold: float) -> pl.DataFrame:
        return (
            orders.lazy()
            .filter(pl.col("qty") >= 2)
            .group_by("cid")
            .agg(pl.col("amount").sum().alias("spend"))
            .sort("spend", descending=True)
            .head(int(threshold))
            .collect()
        )

    def daily_rollup(threshold: float) -> pl.DataFrame:
        return (
            orders.lazy()
            .filter(pl.col("amount") > threshold)
            .group_by("region_id")
            .agg(pl.col("amount").mean())
            .collect()
        )

    jobs = [
        ("nightly-revenue-report", revenue_report),
        ("top-customers", top_customers),
        ("daily-rollup", daily_rollup),
    ]

    deadline = time.time() + DURATION_S
    count = 0
    while time.time() < deadline:
        name, job = random.choice(jobs)  # noqa: S311
        with tracer.start_as_current_span(name) as span:
            span.set_attribute("job.name", name)
            span.set_attribute("job.rows", job(random.choice([10, 20, 30, 50])).height)  # noqa: S311
        count += 1
        time.sleep(random.uniform(0.05, 0.4))  # noqa: S311

    polars_telemetry.uninstall()
    tracer_provider.shutdown()
    meter_provider.shutdown()
    print(f"{count} queries; Grafana http://localhost:3000  Jaeger http://localhost:16686")


if __name__ == "__main__":
    main()
