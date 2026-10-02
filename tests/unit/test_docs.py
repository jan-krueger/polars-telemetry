"""The attribute reference must stay in step with the code.

Attribute names are public API; a dashboard breaks when one changes. An
undocumented attribute is a quieter version of the same problem.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from polars_telemetry.export import semconv

REFERENCE = Path(__file__).parents[2] / "docs" / "attributes.md"


def _declared_names() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(semconv).items()
        if name.isupper() and isinstance(value, str) and value.startswith("polars.")
    }


@pytest.fixture(scope="module")
def reference() -> str:
    return REFERENCE.read_text()


def test_every_attribute_is_documented(reference):
    missing = sorted(value for value in _declared_names().values() if f"`{value}`" not in reference)
    assert missing == [], f"undocumented in docs/attributes.md: {missing}"


def test_every_instrument_is_documented(reference):
    for instrument in ("polars.query.duration", "polars.node.cpu_time", "polars.node.rows_in"):
        assert f"`{instrument}`" in reference, instrument


def test_user_data_attributes_are_called_out(reference):
    section = reference.split("can carry your data")[-1]
    for attribute in sorted(semconv.CARRIES_USER_DATA):
        assert attribute in section, f"{attribute} is not flagged as carrying user data"
