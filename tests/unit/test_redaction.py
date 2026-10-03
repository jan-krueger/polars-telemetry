"""Redacting a whole query, and delivering it redacted to whoever asked."""

from __future__ import annotations

import json
from dataclasses import replace
from uuid import uuid4

import pytest

from polars_telemetry import _dispatch
from polars_telemetry.adapter.build import build_plan, enrich
from polars_telemetry.model.redaction import Redaction, redact, redact_query
from polars_telemetry.model.types import Query
from tests.fixture_paths import latest_fixture

FIXTURE = latest_fixture()


@pytest.fixture
def query() -> Query:
    return enrich(
        Query(
            query_id=uuid4(),
            wall_ms=1.0,
            plan=build_plan(json.loads((FIXTURE / "physical.json").read_text())),
            logical=build_plan(json.loads((FIXTURE / "ir.json").read_text())),
            failed='conversion failed for 1 out of 1 values: ["secret"]',
        )
    )


def _all_text(query: Query) -> str:
    nodes = [*query.plan.values(), *query.logical.values()]
    facets = [(n.scan, n.join, n.sort, n.aggregation) for n in nodes]
    return repr([n.properties for n in nodes]) + repr(facets) + str(query.failed)


def test_every_literal_is_masked_and_every_column_name_kept(query):
    assert "10.0" in _all_text(query), "the fixture filters on amount > 10.0"
    masked = _all_text(redact_query(query))
    assert "10.0" not in masked
    assert "secret" not in masked
    assert "amount" in masked
    assert "customer_id" in masked


def test_facets_are_masked_too(query):
    redacted = redact_query(query)
    predicates = [p for n in redacted.logical.values() if n.scan for p in n.scan.predicates]
    assert predicates
    assert all("10.0" not in p for p in predicates)


def test_the_fingerprint_does_not_depend_on_redaction(query):
    """Computed on arrival, before anything is masked."""
    assert redact_query(query).fingerprint == query.fingerprint


def test_redaction_is_idempotent(query):
    once = redact_query(query)
    assert _all_text(redact_query(once)) == _all_text(once)


# --- delivery -------------------------------------------------------------------


@pytest.fixture
def isolated(monkeypatch):
    monkeypatch.setattr(_dispatch, "_receivers", ())


def test_each_receiver_gets_its_own_setting(isolated, query):
    raw: list[Query] = []
    masked: list[Query] = []
    _dispatch.add(raw.append, "raw")
    _dispatch.add(masked.append, "masked", redaction=Redaction())

    _dispatch.dispatch(query)

    assert "10.0" in _all_text(raw[0])
    assert "10.0" not in _all_text(masked[0])


def test_a_failing_redaction_delivers_nothing_rather_than_raw(isolated, query, monkeypatch):
    def broken(_: Query, __: Redaction) -> Query:
        msg = "redaction bug"
        raise RuntimeError(msg)

    monkeypatch.setattr(_dispatch, "redact_query", broken)
    delivered: list[Query] = []
    _dispatch.add(delivered.append, "masked", redaction=Redaction())

    _dispatch.dispatch(query)
    assert delivered == []


# --- what each switch masks, on the text polars actually writes -------------------


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ('col("email") == "a@b.c"', 'col("email") == "<str>"'),
        ('col("s").str.contains(["^ab.*"])', 'col("s").str.contains(["<str>"])'),
        ('col("x") > 1.0000e-9', 'col("x") > <num>'),
        ('dyn float: 1.5.alias("x")', 'dyn float: <num>.alias("x")'),
        ('2024-01-01.alias("d")', '<date>.alias("d")'),
        ('2024-01-01 12:00:00.alias("t")', '<datetime>.alias("t")'),
        ('12:30:00.alias("tm")', '<time>.alias("tm")'),
        ('1d.alias("dur")', '<duration>.alias("dur")'),
        ('(col("n") * 1000000).alias("big")', '(col("n") * <num>).alias("big")'),
        ('col("d") >= 2023-05-06', 'col("d") >= <date>'),
        ('col("t") < 2024-02-03 04:05:06', 'col("t") < <datetime>'),
        ('col("t") < 2024-02-03 04:05:06.250', 'col("t") < <datetime>'),
        ('col("tm") > 09:15:00', 'col("tm") > <time>'),
        ('col("dur") > 5h', 'col("dur") > <duration>'),
        ('col("dur") > 1d2h30m', 'col("dur") > <duration>'),
        ('col("_POLARS_TMP_0").alias("n2")', 'col("_POLARS_TMP_0").alias("n2")'),
    ],
)
def test_each_literal_form_is_masked_by_kind(expression, expected):
    assert redact(expression) == expected


@pytest.mark.parametrize(
    ("redaction", "kept"),
    [
        (Redaction(strings=False), '"a@b.c"'),
        (Redaction(numbers=False), "60.5"),
        (Redaction(temporal=False), "2023-05-06"),
    ],
)
def test_switching_one_kind_off_keeps_only_that_kind(redaction, kept):
    expression = 'col("e") == "a@b.c" & col("n") > 60.5 & col("d") >= 2023-05-06'
    masked = redact(expression, redaction)
    assert kept in masked
    assert masked.count("<") == 2


def test_digits_inside_text_are_text_not_numbers():
    assert redact('col("s") == "room 101"', Redaction(strings=False)) == 'col("s") == "room 101"'


def test_a_custom_rule_runs_after_the_masks():
    hide_columns = Redaction(custom=lambda text: text.replace('col("email")', 'col("<col>")'))
    assert redact('col("email") == "a@b.c"', hide_columns) == 'col("<col>") == "<str>"'


def test_paths_are_kept_whole_or_masked_whole(query):
    def sources(q: Query) -> set[str]:
        return {
            str(n.properties["first_source"])
            for n in q.logical.values()
            if "first_source" in n.properties
        }

    kept = sources(redact_query(query))
    assert kept
    assert all("<" not in s for s in kept), "a path is not an expression"
    assert sources(redact_query(query, Redaction(paths=True))) == {"<path>"}


def test_call_site_and_label_are_dropped_only_when_asked(query):
    from polars_telemetry.model.types import CallSite

    placed = replace(query, call_site=CallSite("/srv/app.py", 3, "f"), label="nightly")
    assert redact_query(placed).call_site is not None
    assert redact_query(placed).label == "nightly"
    gone = redact_query(placed, Redaction(call_site=True, labels=True))
    assert gone.call_site is None
    assert gone.label is None


def test_a_query_records_what_was_masked(query):
    assert query.redaction is None
    assert redact_query(query, Redaction(paths=True)).redaction == Redaction(paths=True)
    assert Redaction(paths=True).masks == ("strings", "numbers", "temporal", "paths")


def test_receivers_with_different_redactions_each_get_their_own(isolated, query):
    raw: list[Query] = []
    literals: list[Query] = []
    strict: list[Query] = []
    _dispatch.add(raw.append, "raw")
    _dispatch.add(literals.append, "literals", redaction=Redaction())
    _dispatch.add(strict.append, "strict", redaction=Redaction(paths=True))

    _dispatch.dispatch(query)

    assert raw[0].redaction is None
    assert literals[0].redaction == Redaction()
    assert strict[0].redaction == Redaction(paths=True)


def test_the_strictest_redaction_masks_what_any_of_them_masks():
    from polars_telemetry.model.redaction import strictest

    def upper(text: str) -> str:
        return text.upper()

    def tagged(text: str) -> str:
        return text + "!"

    combined = strictest(
        Redaction(paths=True, custom=upper), None, Redaction(labels=True, custom=tagged)
    )
    assert combined is not None
    assert (combined.paths, combined.labels, combined.strings) == (True, True, True)
    assert combined.custom is not None
    assert combined.custom("a") == "A!"
    assert strictest(None, None) is None
    assert strictest(Redaction(), Redaction()) == Redaction()
