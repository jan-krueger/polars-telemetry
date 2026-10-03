"""Exporters and scoped sessions share one registry and one lifecycle."""

from __future__ import annotations

from typing import Any

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config, Redaction, profile, redacted  # noqa: E402
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
    again = polars_telemetry.install(Config(redaction=Redaction()), exporter=Collect())
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


def test_an_application_exporter_receives_redacted_queries():
    """Redaction used to cover only the bundled exporters."""
    mine = Collect()
    polars_telemetry.install(Config(redaction=Redaction()), exporter=mine)
    polars.LazyFrame({"e": ["a"]}).filter(polars.col("e") == "secret@corp.com").collect()

    text = repr(
        [n.properties for q in mine.queries for n in [*q.plan.values(), *q.logical.values()]]
    )
    assert mine.queries
    assert "secret@corp.com" not in text


def _texts(queries) -> str:
    return repr(
        [
            (n.properties, q.failed, q.call_site, q.label)
            for q in queries
            for n in [*q.plan.values(), *q.logical.values()]
        ]
    )


def test_each_exporter_can_have_its_own_redaction():
    """One anonymised copy for a shared backend, full detail kept locally."""
    full, default, strict = Collect(), Collect(), Collect()
    polars_telemetry.install(
        Config(redaction=Redaction()),
        exporter=[
            redacted(full, None),
            default,
            redacted(strict, Redaction(paths=True, call_site=True, labels=True)),
        ],
    )
    with polars_telemetry.label("nightly"):
        polars.LazyFrame({"e": ["a"]}).filter(polars.col("e") == "secret@corp.com").collect()

    assert "secret@corp.com" in _texts(full.queries)
    assert "secret@corp.com" not in _texts(default.queries)
    assert default.queries[-1].label == "nightly"
    assert strict.queries[-1].label is None
    assert strict.queries[-1].call_site is None


def test_the_deprecated_config_flag_still_masks():
    with pytest.warns(DeprecationWarning, match="redact_literals"):
        config = Config(redact_literals=True)
    assert config.redaction == Redaction()


def test_an_otel_exporter_keeps_masking_by_its_own_config():
    """Before 0.3 it masked by the config it was made with, whatever install() got."""
    from polars_telemetry.activation import _redaction_for
    from polars_telemetry.export.otel import OTelExporter

    exporter = OTelExporter(Config(redaction=Redaction()))
    assert _redaction_for(exporter, Config()) == (exporter, Redaction())
    assert _redaction_for(redacted(exporter, None), Config()) == (exporter, None)


def test_uninstall_closes_exporters_that_hold_data():
    closed: list[str] = []

    class Holding(Collect):
        def close(self) -> None:
            closed.append("plain")

    class AlsoHolding(Collect):
        def close(self) -> None:
            closed.append("wrapped")

    polars_telemetry.install(exporter=[Holding(), redacted(AlsoHolding(), None), Collect()])
    polars_telemetry.uninstall()
    assert closed == ["plain", "wrapped"]


def test_a_slow_close_does_not_hold_up_another_install():
    """uninstall() flushes outside its lock, so other threads carry on."""
    import threading

    closing, release = threading.Event(), threading.Event()

    class Slow(Collect):
        def close(self) -> None:
            closing.set()
            release.wait(timeout=10)

    polars_telemetry.install(exporter=Slow())
    leaving = threading.Thread(target=polars_telemetry.uninstall)
    leaving.start()
    try:
        assert closing.wait(timeout=10), "close() was never called"
        fresh = Collect()
        done = threading.Event()

        def install_fresh() -> None:
            polars_telemetry.install(exporter=fresh)
            done.set()

        threading.Thread(target=install_fresh, daemon=True).start()
        assert done.wait(timeout=5), "install() waited for another thread's flush"
        polars.LazyFrame({"a": [1]}).collect()
        assert fresh.queries, "the new installation does not receive queries"
    finally:
        release.set()
        leaving.join(timeout=10)


def _nothing_left_behind() -> None:
    import os
    import sys

    assert installed() is None
    assert "POLARS_QUERY_MONITORING" not in os.environ
    assert os.environ.get("POLARS_ENGINE_AFFINITY") is None
    assert "polars_cloud" not in sys.modules


@pytest.mark.parametrize("bad", ["not-an-exporter", object()])
def test_an_invalid_exporter_is_rejected_before_anything_changes(bad):
    with pytest.raises(TypeError, match="export"):
        polars_telemetry.install(exporter=[Collect(), bad])
    _nothing_left_behind()


def test_a_failed_install_is_undone_and_a_retry_delivers_once(monkeypatch):
    import polars_telemetry.activation as activation

    def broken(config: object) -> object:
        msg = "exporter construction failed"
        raise RuntimeError(msg)

    monkeypatch.setattr(activation, "_default_exporter", broken)
    with pytest.raises(RuntimeError, match="construction failed"):
        polars_telemetry.install()
    _nothing_left_behind()

    mine = Collect()
    polars_telemetry.install(exporter=mine)
    polars.LazyFrame({"a": [1]}).collect()
    assert len(mine.queries) == 1
    polars_telemetry.uninstall()
    _nothing_left_behind()


def test_a_config_of_the_wrong_type_is_rejected():
    with pytest.raises(TypeError, match="Config"):
        polars_telemetry.install({"node_metrics": False}, exporter=Collect())  # type: ignore[arg-type]
    _nothing_left_behind()


@pytest.fixture
def polars_cloud(monkeypatch):
    """A stand-in for the real polars-cloud package, recording what polars asks of it."""
    import sys
    import types

    calls: list[tuple[str | None, str | None]] = []

    class Observer:
        def on_query_started(self, query_id: object) -> None:
            pass

        def on_query_planned(self, *args: object) -> object:
            return types.SimpleNamespace(close=lambda: None)

        def on_query_failed(self, *args: object) -> None:
            pass

    def factory(workspace: str | None = None, organization: str | None = None) -> Observer:
        calls.append((workspace, organization))
        return Observer()

    module = types.ModuleType("polars_cloud")
    module.authenticate = lambda *args, **kwargs: None  # type: ignore[attr-defined]
    module.QueryCloudObserver = factory  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "polars_cloud", module)
    for key in (
        "POLARS_QUERY_MONITORING",
        "POLARS_QUERY_MONITORING_WORKSPACE",
        "POLARS_QUERY_MONITORING_ORGANIZATION",
    ):
        monkeypatch.delenv(key, raising=False)
    yield module, calls
    polars_telemetry.uninstall()
    polars.Config.enable_monitoring(False)
    polars.Config.set_engine_affinity(None)


def test_polars_cloud_keeps_its_workspace_and_stays_on_after_uninstall(polars_cloud):
    import sys

    module, calls = polars_cloud
    query = polars.LazyFrame({"a": [1, 2]}).filter(polars.col("a") > 1)
    polars.Config.enable_monitoring(workspace="prod", organization="acme")

    mine = Collect()
    polars_telemetry.install(exporter=mine)
    calls.clear()
    query.collect()
    assert calls == [("prod", "acme")], "polars-cloud still receives every query, for its workspace"
    assert len(mine.queries) == 1, "and so does polars-telemetry"

    polars_telemetry.uninstall()
    assert sys.modules["polars_cloud"] is module
    calls.clear()
    query.collect()
    assert calls == [("prod", "acme")], "polars-cloud monitoring is still on after uninstall"


def _capabilities(**problems: Any) -> object:
    from dataclasses import replace

    from polars_telemetry.compat import Capabilities

    healthy = Capabilities(
        polars_version=polars.__version__,
        has_monitoring_api=True,
        observer_callbacks_ok=True,
        plan_payload_ok=True,
        ir_payload_ok=True,
        metrics_snapshot_ok=True,
    )
    return replace(healthy, **problems)


def test_an_unusable_polars_installs_nothing_and_undoes_itself(monkeypatch, caplog):
    import polars_telemetry.activation as activation

    monkeypatch.setattr(
        activation, "probe", lambda binding: _capabilities(observer_callbacks_ok=False)
    )
    polars.Config.set_engine_affinity("in-memory")
    try:
        assert polars_telemetry.install(exporter=Collect()) is None
        assert installed() is None
        assert activation._engine_affinity() == "in-memory"
        assert any("not installed" in r.getMessage() for r in caplog.records)
    finally:
        polars.Config.set_engine_affinity(None)


@pytest.mark.parametrize("problem", ["metrics_snapshot_ok", "plan_payload_ok"])
def test_unusable_payloads_fall_back_to_query_spans(monkeypatch, problem):
    import polars_telemetry.activation as activation

    monkeypatch.setattr(activation, "probe", lambda binding: _capabilities(**{problem: False}))
    mine = Collect()
    state = polars_telemetry.install(exporter=mine)
    assert state is not None
    assert state.config.node_metrics is False
    polars.LazyFrame({"a": [1]}).collect()
    assert mine.queries, "query spans still flow"
    assert mine.queries[-1].metrics == {}


def test_an_unexpected_ir_is_reported(monkeypatch, caplog):
    import polars_telemetry.activation as activation

    monkeypatch.setattr(activation, "probe", lambda binding: _capabilities(ir_payload_ok=False))
    assert polars_telemetry.install(exporter=Collect()) is not None
    assert any("unexpected IR plan" in r.getMessage() for r in caplog.records)
