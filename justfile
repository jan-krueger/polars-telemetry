default:
    @just --list

# Collector + Jaeger, then a sample query; prints the trace URL.
dev:
    docker compose -f docker/compose.yaml up -d --wait
    uv sync
    uv run python examples/workload.py

urls:
    @echo "Grafana:    http://localhost:3000/d/polars-telemetry/polars-telemetry"
    @echo "Jaeger:     http://localhost:16686"
    @echo "Prometheus: http://localhost:9090"

down:
    docker compose -f docker/compose.yaml down -v

test:
    uv run pytest -m "not integration and not bench"

integration:
    docker compose -f docker/compose.yaml up -d --wait
    uv run pytest -m integration

lint:
    uv run ruff check .
    uv run ruff format --check .

typecheck:
    uv run mypy

docs:
    uv run --group docs mkdocs serve

docs-build:
    uv run --group docs mkdocs build --strict

matrix:
    uv run nox -s tests

# Live contract against the newest polars, quarantine lifted for polars only.
canary:
    uv run nox -s canary

# Regenerate fixtures: just capture 1.44.2
capture version:
    uv run nox -s capture -- {{version}}
