"""Plan fingerprints: stable across parameters, distinct across shapes."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from polars_telemetry.model.build import build_plan
from polars_telemetry.model.fingerprint import FINGERPRINT_LENGTH, fingerprint

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


@pytest.fixture
def plan():
    return build_plan(json.loads((FIXTURE / "ir.json").read_text()))


def test_is_a_short_stable_hex_digest(plan):
    value = fingerprint(plan)
    assert len(value) == FINGERPRINT_LENGTH
    assert int(value, 16) >= 0
    assert value == fingerprint(plan)


def test_literal_values_do_not_change_the_shape(plan):
    """A predicate threshold is a parameter, not a different query."""
    other = copy.deepcopy(plan)
    for node in other.values():
        pred = node.properties.get("predicate")
        if isinstance(pred, list) and pred:
            node.properties["predicate"] = [str(pred[0]).replace("10.0", "99999.0")]

    assert fingerprint(other) == fingerprint(plan)


def test_column_changes_do_change_the_shape(plan):
    other = copy.deepcopy(plan)
    for node in other.values():
        if node.kind == "GroupBy":
            node.properties["keys"] = ['col("something_else")']
            break

    assert fingerprint(other) != fingerprint(plan)


def test_topology_changes_the_shape(plan):
    other = dict(plan)
    other.pop(max(other))

    assert fingerprint(other) != fingerprint(plan)


def test_empty_plan_still_hashes():
    assert len(fingerprint({})) == FINGERPRINT_LENGTH


def test_the_fingerprint_of_the_captured_plan_is_pinned():
    """A refactor that moves where structural keys come from must not change
    the hash: it is a metric dimension, and every series would restart."""
    ir = Path(__file__).parents[1] / "fixtures" / "1.44.2" / "ir.json"
    assert fingerprint(build_plan(json.loads(ir.read_text()))) == "94b7e38a9c1e"
