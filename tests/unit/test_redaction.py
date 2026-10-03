"""Redacting a whole query, and delivering it redacted to whoever asked."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry import _dispatch
from polars_telemetry.adapter.build import build_plan, enrich
from polars_telemetry.model.redaction import redact_query
from polars_telemetry.model.types import Query

FIXTURE = Path(__file__).parents[1] / "fixtures" / "1.44.2"


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
    _dispatch.add(masked.append, "masked", redact=True)

    _dispatch.dispatch(query)

    assert "10.0" in _all_text(raw[0])
    assert "10.0" not in _all_text(masked[0])


def test_a_failing_redaction_delivers_nothing_rather_than_raw(isolated, query, monkeypatch):
    def broken(_: Query) -> Query:
        msg = "redaction bug"
        raise RuntimeError(msg)

    monkeypatch.setattr(_dispatch, "redact_query", broken)
    delivered: list[Query] = []
    _dispatch.add(delivered.append, "masked", redact=True)

    _dispatch.dispatch(query)
    assert delivered == []
