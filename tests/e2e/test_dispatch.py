"""Exporters and scoped sessions share one registry and one lifecycle."""

from __future__ import annotations

from typing import Any

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config, profile  # noqa: E402
from polars_telemetry.activation import installed  # noqa: E402


class Collect:
    def __init__(self) -> None:
        self.queries: list[Any] = []

    def export(self, query: Any) -> None:
        self.queries.append(query)


class Broken:
    calls = 0

    def export(self, query: Any) -> None:
        Broken.calls += 1
        msg = "exporter bug"
        raise RuntimeError(msg)


def _run() -> None:
    polars.LazyFrame({"a": [1, 2, 3]}).filter(polars.col("a") > 1).collect()


@pytest.fixture(autouse=True)
def _clean():
    yield
    polars_telemetry.uninstall()


def test_several_exporters_each_receive_every_query():
    first, second = Collect(), Collect()
    polars_telemetry.install(exporter=[first, second])
    _run()
    _run()
    assert len(first.queries) == 2
    assert len(second.queries) == 2


def test_a_broken_exporter_disarms_itself_and_no_other():
    Broken.calls = 0
    working = Collect()
    polars_telemetry.install(exporter=[Broken(), working])
    for _ in range(8):
        _run()
    assert len(working.queries) == 8, "a sibling exporter's bug cost this one queries"
    assert Broken.calls == 5, "the broken exporter should stop being called once disarmed"


def test_installing_again_with_different_arguments_says_so(caplog):
    polars_telemetry.install(exporter=Collect())
    state = installed()
    again = polars_telemetry.install(Config(redact_literals=True), exporter=Collect())
    assert again is state
    assert any("already installed" in r.getMessage() for r in caplog.records)


def test_installing_inside_a_profile_block_takes_ownership():
    """The application's exporter must not be dropped because a block was open."""
    app = Collect()
    with profile() as session:
        polars_telemetry.install(exporter=app)
        _run()
    _run()

    assert len(session) == 1
    assert len(app.queries) == 2, "the app's exporter missed queries"
    state = installed()
    assert state is not None, "closing the block uninstalled the application's installation"
    assert not state.scoped


def test_the_config_of_an_adopting_install_applies():
    with profile():
        polars_telemetry.install(Config(call_site=False), exporter=Collect())
        state = installed()
    assert state is not None
    assert state.config.call_site is False


def test_overlapping_blocks_keep_instrumentation_until_the_last_closes():
    """Blocks on different threads close in any order, not innermost first.

    The block that installed closes first here; the other must keep
    collecting. Entered by hand to force that order deterministically.
    """
    early = profile()
    late = profile()
    early.__enter__()  # installs
    late_session = late.__enter__()  # joins
    early.__exit__(None, None, None)  # the installer leaves first

    _run()
    assert len(late_session) == 1, "the late block lost instrumentation when the early one closed"

    late.__exit__(None, None, None)
    assert installed() is None, "the last block to close takes it back out"


def test_resource_attributes_warns_that_it_does_nothing():
    with pytest.warns(DeprecationWarning, match="resource_attributes"):
        Config(resource_attributes={"service.name": "x"})
