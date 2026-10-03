"""Plan fingerprints: stable across parameters, distinct across shapes."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from polars_telemetry.adapter.build import build_plan
from polars_telemetry.adapter.fingerprint import FINGERPRINT_LENGTH, fingerprint
from tests.fixture_paths import latest_fixture

FIXTURE = latest_fixture()


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


def test_a_plugin_counts_by_its_library_name_not_where_it_is_installed(plan):
    """A different virtualenv, Python version or CPU must not start a new metric series."""
    installed = {
        "laptop": "/home/dev/.venv/lib/python3.12/site-packages/mypkg/"
        "mypkg.cpython-312-x86_64-linux-gnu.so",
        "server": "/app/plugin/mypkg/mypkg.cpython-311-aarch64-linux-gnu.so",
    }
    prints = []
    for path in installed.values():
        other = copy.deepcopy(plan)
        node = next(iter(other.values()))
        node.properties["aggs"] = [f'col("v").{path}:encrypt().alias("w")']
        prints.append(fingerprint(other))
    assert prints[0] == prints[1]
    elsewhere = copy.deepcopy(plan)
    next(iter(elsewhere.values())).properties["aggs"] = ['col("v").otherpkg:encrypt().alias("w")']
    assert fingerprint(elsewhere) != prints[0]
