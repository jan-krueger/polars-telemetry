"""The dependency direction that keeps a polars change in one place.

polars' interface is private and can change in any release. Only the adapter
may know it; the model is the stable vocabulary in the middle, and exporters
read the model. An import pointing the wrong way is how polars-shaped knowledge
leaks out of the adapter, so it is checked rather than remembered.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PACKAGE = Path(__file__).parents[2] / "src" / "polars_telemetry"

# What each layer must never import, directly.
FORBIDDEN: dict[str, tuple[str, ...]] = {
    "model": (
        "polars",
        "polars_telemetry.adapter",
        "polars_telemetry.export",
        "polars_telemetry.activation",
        "polars_telemetry.session",
        "polars_telemetry._callsite",
    ),
    "export": (
        "polars",
        "polars_telemetry.adapter",
        "polars_telemetry.activation",
        "polars_telemetry.session",
        "polars_telemetry._callsite",
        "polars_telemetry.compat",
    ),
}


def _imports(path: Path) -> list[str]:
    names: list[str] = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module)
            # `from polars_telemetry import X` reaches the package root.
            if node.module == "polars_telemetry":
                names.append("polars_telemetry (root)")
    return names


def _violates(name: str, rule: str) -> bool:
    return name == rule or name.startswith(rule + ".")


@pytest.mark.parametrize("layer", sorted(FORBIDDEN))
def test_layer_imports_point_inward(layer: str) -> None:
    offenders = [
        f"{path.relative_to(PACKAGE)} imports {name}"
        for path in sorted((PACKAGE / layer).glob("*.py"))
        for name in _imports(path)
        if any(_violates(name, rule) for rule in FORBIDDEN[layer])
        or name == "polars_telemetry (root)"
    ]
    assert offenders == []
