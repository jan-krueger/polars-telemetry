"""Every task, defined once.

CI calls these sessions rather than re-spelling the commands, so "what lint
means" has a single definition. Sessions marked ``venv_backend="none"`` run in
the environment nox was started from -- use ``uv run nox -s <name>``.

    uv run nox -l            list sessions
    uv run nox               lint, typecheck and the test suite
"""

from __future__ import annotations

import os
from pathlib import Path

import nox

nox.options.default_venv_backend = "uv"
nox.options.reuse_existing_virtualenvs = True
nox.options.sessions = ["lint", "typecheck", "test"]

PYTHONS = ["3.10", "3.11", "3.12", "3.13"]

# The hook does not exist before 1.44.0, and 1.44.0's runtime is yanked.
POLARS_VERSIONS = ["1.44.1", "1.44.2"]

# Integration needs a collector; bench is timing-sensitive and measured apart.
DEFAULT_MARKERS = "not integration and not bench"

COMPOSE = ("docker", "compose", "-f", "docker/compose.yaml")
COMPOSE_INFLUX = (*COMPOSE, "-f", "docker/compose.influx.yaml")

_IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"


# --- checks -----------------------------------------------------------------


@nox.session(venv_backend="none")
def lint(session: nox.Session) -> None:
    """ruff check and format --check."""
    # The GitHub format turns findings into inline annotations on the PR.
    report = ["--output-format=github"] if _IN_CI else []
    session.run("ruff", "check", *report, ".")
    session.run("ruff", "format", "--check", ".")


@nox.session(venv_backend="none")
def typecheck(session: nox.Session) -> None:
    """mypy, strict."""
    session.run("mypy")


@nox.session(venv_backend="none")
def test(session: nox.Session) -> None:
    """The suite, minus what needs a collector or a quiet machine."""
    session.run("pytest", "-m", DEFAULT_MARKERS, *session.posargs)


@nox.session(venv_backend="none")
def integration(session: nox.Session) -> None:
    """Against a running collector -- `nox -s up` first."""
    session.run("pytest", "-m", "integration", *session.posargs)


@nox.session(python=PYTHONS)
@nox.parametrize("polars", POLARS_VERSIONS)
def matrix(session: nox.Session, polars: str) -> None:
    """The python x polars grid, each cell isolated."""
    session.install("-e", ".", f"polars=={polars}", "pytest", "pytest-cov")
    session.run("pytest", "-m", DEFAULT_MARKERS, *session.posargs)


@nox.session
def canary(session: nox.Session) -> None:
    """Live contract against the newest polars, pre-releases included.

    Lifts the release quarantine for polars only.
    """
    session.install("-e", ".", "pytest")
    session.run(
        "uv",
        "pip",
        "install",
        "--prerelease=allow",
        "--exclude-newer-package",
        "polars=2099-01-01",
        "--upgrade",
        "polars",
        external=True,
    )
    session.run("pytest", "-m", "contract and live", "-v", *session.posargs)


@nox.session
def bench(session: nox.Session) -> None:
    """Overhead against the budget. Isolated, because it measures timing."""
    session.install("-e", ".", "pytest")
    session.run("pytest", "-m", "bench", *session.posargs)


@nox.session(venv_backend="none")
def audit(session: nox.Session) -> None:
    """Known vulnerabilities in the locked dependencies, Python and the viewer's.

    Kept apart from the test sessions because it needs the network, and a
    registry hiccup should not fail a test run.
    """
    session.run("uv", "run", "--with", "pip-audit", "pip-audit", external=True)
    root = Path.cwd()
    session.chdir("viewer")
    try:
        session.run("npm", "ci", external=True)
        # Only what ships in the page; build tooling has its own advisories.
        session.run("npm", "audit", "--omit=dev", external=True)
    finally:
        session.chdir(root)


# --- build ------------------------------------------------------------------


@nox.session(venv_backend="none")
def viewer(session: nox.Session) -> None:
    """Build the profile viewer into docs/viewer (generated; not committed)."""
    root = Path.cwd()
    session.chdir("viewer")
    try:
        session.run("npm", "ci", external=True)
        session.run("npm", "run", "build", external=True)
    finally:
        session.chdir(root)


@nox.session(venv_backend="none", name="viewer-test")
def viewer_test(session: nox.Session) -> None:
    """The viewer's type check, unit tests and CSS collision check. Offline."""
    root = Path.cwd()
    session.chdir("viewer")
    try:
        session.run("npm", "ci", external=True)
        session.run("npx", "tsc", "--noEmit", external=True)
        session.run("npx", "vitest", "run", external=True)
        session.run("node", "scripts/check-css.mjs", external=True)
    finally:
        session.chdir(root)


@nox.session(venv_backend="none")
def docs(session: nox.Session) -> None:
    """Serve the documentation locally."""
    viewer(session)
    session.run("uv", "run", "--group", "docs", "mkdocs", "serve", external=True)


@nox.session(venv_backend="none", name="docs-build")
def docs_build(session: nox.Session) -> None:
    """Build the documentation the way CI does."""
    viewer(session)
    session.run("uv", "run", "--group", "docs", "mkdocs", "build", "--strict", external=True)


@nox.session(venv_backend="none", name="viewer-fixture")
def viewer_fixture(session: nox.Session) -> None:
    """Regenerate the viewer's fixture from the captured polars payloads."""
    session.run("python", "tests/tools/viewer_fixture.py")


@nox.session(venv_backend="none")
def capture(session: nox.Session) -> None:
    """Regenerate fixtures for one polars version: nox -s capture -- 1.44.2"""
    version = session.posargs[0] if session.posargs else POLARS_VERSIONS[-1]
    session.run("uv", "pip", "install", f"polars=={version}", external=True)
    session.run("python", "tests/tools/capture.py", f"tests/fixtures/{version}")


# --- the local stack --------------------------------------------------------


@nox.session(venv_backend="none")
def up(session: nox.Session) -> None:
    """Collector, Jaeger, Prometheus and Grafana."""
    session.run(*COMPOSE, "up", "-d", "--wait", external=True)


@nox.session(venv_backend="none")
def down(session: nox.Session) -> None:
    """Stop the stack and drop its volumes."""
    session.run(*COMPOSE_INFLUX, "down", "-v", external=True)


@nox.session(venv_backend="none")
def dev(session: nox.Session) -> None:
    """Bring the stack up and run a sample workload through it."""
    up(session)
    session.run("python", "examples/workload.py")
    urls(session)


@nox.session(venv_backend="none")
def influx(session: nox.Session) -> None:
    """Add Telegraf and InfluxDB to the stack."""
    session.run(*COMPOSE_INFLUX, "up", "-d", "--wait", external=True)
    session.log("InfluxDB:  http://localhost:8086  (polars / polars-telemetry)")
    session.log("Telegraf OTLP endpoint: localhost:4327")


@nox.session(venv_backend="none")
def urls(session: nox.Session) -> None:
    """Where to look."""
    session.log("Grafana:    http://localhost:3000/d/polars-telemetry/polars-telemetry")
    session.log("Jaeger:     http://localhost:16686")
    session.log("Prometheus: http://localhost:9090")
