"""The factory module is bound under whatever name polars resolved."""

from __future__ import annotations

import sys
import types

import pytest

from polars_telemetry.adapter import module as mod

_dependencies = pytest.importorskip("polars._dependencies")


@pytest.fixture
def polars_resolves(monkeypatch):
    def resolve(name: str) -> None:
        monkeypatch.setattr(_dependencies, "polars_cloud", types.ModuleType(name), raising=False)
        monkeypatch.delitem(sys.modules, name, raising=False)

    return resolve


def test_the_stand_in_takes_the_name_polars_resolved(polars_resolves):
    polars_resolves("polars_nanook")
    binding = mod.bind()
    assert binding.injected
    assert sys.modules["polars_nanook"] is binding.module
    assert "polars_cloud" not in sys.modules
    mod.unbind(binding)
    assert "polars_nanook" not in sys.modules


def test_an_installed_package_under_the_new_name_is_taken_over_and_restored(
    polars_resolves, monkeypatch
):
    polars_resolves("polars_nanook")
    real = types.ModuleType("polars_nanook")
    original = object()
    real.QueryCloudObserver = original  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "polars_nanook", real)

    binding = mod.bind()
    assert not binding.injected
    assert binding.module is real
    mod.set_factory(binding, "ours")
    assert real.QueryCloudObserver == "ours"
    mod.unbind(binding)
    assert real.QueryCloudObserver is original
    assert sys.modules["polars_nanook"] is real


def test_polars_without_the_lookup_falls_back_to_polars_cloud(monkeypatch):
    monkeypatch.delattr(_dependencies, "polars_cloud", raising=False)
    assert mod.module_name() == "polars_cloud"
