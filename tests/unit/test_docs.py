"""The attribute reference must stay in step with the code.

Attribute names are public API; a dashboard breaks when one changes. An
undocumented attribute is a quieter version of the same problem.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from polars_telemetry import Config
from polars_telemetry.export import semconv
from polars_telemetry.export.measurements import COUNTERS, HISTOGRAMS

ROOT = Path(__file__).parents[2]
REFERENCE = ROOT / "docs" / "reference" / "spans-and-metrics.md"


def _declared_names() -> dict[str, str]:
    """Every attribute, instrument and span name the package can emit."""
    return {
        name: value
        for name, value in vars(semconv).items()
        if name.isupper() and isinstance(value, str) and "." in value
    }


@pytest.fixture(scope="module")
def reference() -> str:
    return REFERENCE.read_text()


def test_every_attribute_is_documented(reference):
    missing = sorted(value for value in _declared_names().values() if f"`{value}`" not in reference)
    assert missing == [], f"undocumented in docs/reference/spans-and-metrics.md: {missing}"


def test_every_instrument_is_documented(reference):
    for instrument in ("polars.query.duration", "polars.node.cpu_time", "polars.node.rows_in"):
        assert f"`{instrument}`" in reference, instrument


def test_user_data_attributes_are_called_out(reference):
    section = reference.split("can carry your data")[-1]
    for attribute in sorted(semconv.CARRIES_USER_DATA):
        assert attribute in section, f"{attribute} is not flagged as carrying user data"


def test_every_instrument_row_states_the_unit_it_is_registered_with(reference):
    """Units are public API: an OTLP-to-Prometheus translator derives the
    series suffix from them, so a wrong one sends dashboards to a wrong name."""
    rows = dict(
        re.findall(r"\| `(polars\.[a-z_.]+)` \| (?:histogram|counter) \| ([^|]*?) \|", reference)
    )
    wrong = {
        name: (rows[name], unit)
        for name, unit, _ in (*HISTOGRAMS, *COUNTERS)
        if name in rows and rows[name] != unit
    }
    assert wrong == {}, f"documented unit != registered unit: {wrong}"

    missing = [name for name, _, _ in (*HISTOGRAMS, *COUNTERS) if name not in rows]
    assert missing == [], f"instruments with no table row: {missing}"


def test_every_config_option_is_in_both_option_tables():
    """A documented knob nobody can find is the same as an undocumented one."""
    options = set(Config.__dataclass_fields__)
    for path in (ROOT / "README.md", ROOT / "docs" / "reference" / "configuration.md"):
        text = path.read_text()
        table = set(re.findall(r"\| `([a-z_]+)` \| `?[^|]*?`? \|", text))
        assert options <= table, f"{path.name} omits {sorted(options - table)}"


def test_every_insight_rule_is_documented():
    from polars_telemetry.model.insights.rules import RULES

    page = (Path(__file__).parents[2] / "docs" / "insights.md").read_text()
    missing = [rule.id for rule in RULES if f"### `{rule.id}`" not in page]
    assert missing == []
