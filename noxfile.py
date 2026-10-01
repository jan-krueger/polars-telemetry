"""Local sessions, mirroring CI."""

from __future__ import annotations

import nox

nox.options.default_venv_backend = "uv"
nox.options.reuse_existing_virtualenvs = True
nox.options.sessions = ["lint", "typecheck", "tests"]

PYTHONS = ["3.10", "3.11", "3.12", "3.13"]

# The hook does not exist before 1.44.0, and 1.44.0's runtime is yanked.
POLARS_VERSIONS = ["1.44.1", "1.44.2"]


@nox.session
def lint(session: nox.Session) -> None:
    session.install("ruff")
    session.run("ruff", "check", ".")
    session.run("ruff", "format", "--check", ".")


@nox.session
def typecheck(session: nox.Session) -> None:
    session.install("-e", ".", "mypy", "pytest")
    session.run("mypy")


@nox.session(python=PYTHONS)
@nox.parametrize("polars", POLARS_VERSIONS)
def tests(session: nox.Session, polars: str) -> None:
    """Unit, golden-contract and live-contract tests on one matrix cell."""
    session.install("-e", ".", f"polars=={polars}", "pytest", "pytest-cov")
    session.run("pytest", "-m", "not integration and not bench", *session.posargs)


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
    """Overhead against the budget."""
    session.install("-e", ".", "pytest")
    session.run("pytest", "-m", "bench", *session.posargs)


@nox.session
def capture(session: nox.Session) -> None:
    """Regenerate fixtures for one polars version: nox -s capture -- 1.44.2"""
    version = session.posargs[0] if session.posargs else POLARS_VERSIONS[-1]
    session.install("-e", ".", f"polars=={version}")
    session.run("python", "-m", "tests.tools.capture", version)
