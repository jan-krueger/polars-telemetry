"""The viewer's fixtures are derived from the Python side and must stay so."""

from __future__ import annotations

from tests.tools.viewer_fixture import ROOT, dialect_table, profile_document, render

FIXTURES = ROOT / "viewer" / "tests" / "fixtures"
STALE = "the viewer's fixture is stale: run `uv run nox -s viewer-fixture`"


def test_the_profile_fixture_is_what_the_exporter_writes_today():
    assert (FIXTURES / "profile.json").read_text() == render(profile_document()), STALE


def test_the_dialect_fixture_is_the_current_role_table():
    assert (FIXTURES / "dialect.json").read_text() == render(dialect_table()), STALE
