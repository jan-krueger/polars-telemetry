"""Collecting the queries run inside a block."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

import polars_telemetry  # noqa: E402
from polars_telemetry import Config, Redaction, Session, profile  # noqa: E402
from polars_telemetry.activation import installed  # noqa: E402
from polars_telemetry.export.base import Exporter  # noqa: E402


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
    with profile(Config(redaction=Redaction())) as session:
        _filter_on_a_secret()

    assert "secret@corp.com" not in json.dumps(session.profiles())
    assert "secret@corp.com" not in session.write(tmp_path / "s.jsonl").read_text()


def test_an_installed_config_redacts_a_block_that_names_none():
    """A session must not hand out literals the running config would mask."""
    polars_telemetry.install(Config(redaction=Redaction()), exporter=_Nothing())
    with profile() as session:
        _filter_on_a_secret()

    assert "secret@corp.com" not in json.dumps(session.profiles())


def test_literals_are_kept_by_default():
    """Full fidelity is the default; redaction is opt-in."""
    with profile() as session:
        _filter_on_a_secret()

    assert "secret@corp.com" in json.dumps(session.profiles())


class _Nothing:
    def export(self, query: object) -> None:
        return


def test_a_label_reaches_the_query_and_its_profile():
    from polars_telemetry import label

    with profile() as session, label("tpch"), label("q3"):
        _run()
    assert session[0].label == "tpch/q3"
    assert session.profiles()[0]["label"] == "tpch/q3"


def test_queries_outside_a_label_have_none():
    with profile() as session:
        _run()
    assert session[0].label is None


@pytest.mark.parametrize(
    ("value", "secret"),
    [
        ("C:\\Users\\alice\\", "alice@example.com"),
        ('O"Brien SSN 123-45-6789', "Brien"),
        ('"ssn":"123-45-6789"', "ssn"),
    ],
)
def test_literals_with_quotes_or_backslashes_are_masked(value, secret):
    frame = polars.LazyFrame({"a": ["x"], "b": ["y"]})
    with profile(Config(redaction=Redaction())) as session:
        either = (polars.col("a") == value) | (polars.col("b") == "alice@example.com")
        frame.filter(either).collect()
    text = json.dumps(session.profiles())
    assert secret not in text
    assert "123-45-6789" not in text


def test_written_paths_are_masked_with_paths_on(tmp_path):
    target = tmp_path / "alice_private" / "out.parquet"
    target.parent.mkdir()
    with profile(Config(redaction=Redaction(paths=True))) as session:
        polars.LazyFrame({"a": [1]}).sink_parquet(target)
    assert session.profiles(), "the sink ran as a query"
    assert "alice_private" not in json.dumps(session.profiles())


def test_a_block_config_never_masks_less_than_the_installation():
    polars_telemetry.install(Config(redaction=Redaction(call_site=True)), exporter=_Nothing())
    with profile(Config(include_plan=True)) as session:
        _filter_on_a_secret()
    assert "secret@corp.com" not in json.dumps(session.profiles())
    assert session[0].call_site is None


def test_a_block_config_can_mask_more_than_the_installation():
    polars_telemetry.install(Config(redaction=Redaction()), exporter=_Nothing())
    with profile(Config(redaction=Redaction(call_site=True))) as session:
        _filter_on_a_secret()
    assert "secret@corp.com" not in json.dumps(session.profiles())
    assert session[0].call_site is None


def _fingerprint(frame: Any) -> str:
    with profile() as session:
        frame.collect()
    return session[-1].fingerprint


def _write(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    polars.DataFrame({"k": ["a"], "v": [1], "c": ["cust_1"]}).write_parquet(path)
    return path


@pytest.mark.parametrize(
    "build",
    [
        lambda n: (
            polars.LazyFrame({"k": ["a"], "v": [1], "c": [f"cust_{n}"]})
            .group_by("k")
            .agg(polars.col("v").filter(polars.col("c") == f"cust_{n}").sum())
        ),
        lambda n: polars.LazyFrame({"v": [1]}).group_by(polars.col("v") > n).len(),
        lambda n: polars.LazyFrame({"v": [1]}).sort(polars.col("v") * n),
    ],
    ids=["literal in an aggregation", "literal in a key", "literal in a sort"],
)
def test_literals_do_not_change_the_fingerprint(build):
    assert _fingerprint(build(123)) == _fingerprint(build(456))


def test_dated_file_names_share_a_fingerprint_and_tables_do_not(tmp_path):
    def scan(path: Path) -> Any:
        return polars.scan_parquet(path).select("v")

    monday = _write(tmp_path / "2024" / "data-2024-01-01.parquet")
    tuesday = _write(tmp_path / "other" / "data-2024-01-02.parquet")
    orders = _write(tmp_path / "orders.parquet")
    assert _fingerprint(scan(monday)) == _fingerprint(scan(tuesday))
    assert _fingerprint(scan(monday)) != _fingerprint(scan(orders))
