"""Collecting the queries run inside a block."""

from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config, Session, profile  # noqa: E402
from polars_telemetry.activation import installed  # noqa: E402
from polars_telemetry.export.base import Exporter  # noqa: E402
from polars_telemetry.session import _Discard  # noqa: E402


def _run(value: int = 1):
    return (
        polars.LazyFrame({"a": [value, value + 1, value + 2], "g": ["x", "x", "y"]})
        .group_by("g")
        .agg(polars.col("a").sum())
        .collect()
    )


@pytest.fixture(autouse=True)
def _no_leftover_installation():
    yield
    polars_telemetry.uninstall()


def test_queries_in_the_block_are_collected():
    with profile() as session:
        _run()
        _run(10)

    assert len(session) == 2
    assert all(query.plan for query in session)
    assert session.wall_ms > 0


def test_nothing_is_collected_after_the_block():
    with profile() as session:
        _run()
    _run()

    assert len(session) == 1


def test_the_block_installs_only_when_nothing_was_installed():
    assert installed() is None
    with profile():
        assert installed() is not None
    assert installed() is None, "the block must take back what it put in place"


def test_an_existing_installation_is_left_alone_and_still_exports():
    exported = []

    class Collect(Exporter):
        def export(self, query):
            exported.append(query)

        def shutdown(self) -> None:
            pass

    state = polars_telemetry.install(exporter=Collect())
    assert state is not None

    with profile() as session:
        _run()

    assert len(session) == 1, "the block collected nothing"
    assert len(exported) == 1, "the application's own exporter was bypassed"
    assert installed() is state, "the block replaced a live installation"


def test_blocks_nest():
    with profile() as outer:
        _run()
        with profile() as inner:
            _run()
        _run()

    assert len(inner) == 1
    assert len(outer) == 3


def test_an_exception_still_removes_the_sink():
    captured: list[Session] = []

    def pipeline_that_fails() -> None:
        with profile() as session:
            captured.append(session)
            _run()
            msg = "pipeline blew up"
            raise RuntimeError(msg)

    with pytest.raises(RuntimeError):
        pipeline_that_fails()

    session = captured[0]
    assert len(session) == 1
    _run()
    assert len(session) == 1, "the sink outlived the block"


def test_the_slowest_query_is_identified():
    with profile() as session:
        _run()
        _run(10)

    assert session.slowest is not None
    assert session.slowest.wall_ms == max(query.wall_ms for query in session)


def test_queries_carry_their_call_site():
    with profile() as session:
        _run()

    site = session[0].call_site
    assert site is not None
    assert site.function == "_run"


def test_config_applies_when_the_block_installs():
    with profile(Config(call_site=False)) as session:
        _run()

    assert session[0].call_site is None


def test_a_session_writes_a_file_the_viewer_can_open(tmp_path):
    with profile() as session:
        _run()
        _run(10)

    written = session.write(tmp_path / "nested" / "session.jsonl")
    lines = written.read_text().splitlines()

    assert len(lines) == 2
    document = json.loads(lines[0])
    assert document["schema"].startswith("polars-telemetry/profile@")
    assert document["plan"]["physical"]


def test_an_empty_block_is_not_an_error(tmp_path):
    with profile() as session:
        pass

    assert len(session) == 0
    assert session.slowest is None
    assert session.write(tmp_path / "empty.jsonl").read_text() == ""


def _filter_on_a_secret() -> object:
    return (
        polars.LazyFrame({"email": ["a@b.c"]})
        .filter(polars.col("email") == "secret@corp.com")
        .collect()
    )


def test_the_block_config_redacts_what_the_session_hands_out(tmp_path):
    with profile(Config(redact_literals=True)) as session:
        _filter_on_a_secret()

    assert "secret@corp.com" not in json.dumps(session.profiles())
    assert "secret@corp.com" not in session.write(tmp_path / "s.jsonl").read_text()


def test_an_installed_config_redacts_a_block_that_names_none():
    """A session must not hand out literals the running config would mask."""
    polars_telemetry.install(Config(redact_literals=True), exporter=_Discard())
    with profile() as session:
        _filter_on_a_secret()

    assert "secret@corp.com" not in json.dumps(session.profiles())


def test_literals_are_kept_by_default():
    """Full fidelity is the default; redaction is opt-in."""
    with profile() as session:
        _filter_on_a_secret()

    assert "secret@corp.com" in json.dumps(session.profiles())
