"""CI's test matrix tests the polars versions the noxfile names, no other."""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_ci_matrix_and_noxfile_name_the_same_polars():
    tree = ast.parse((ROOT / "noxfile.py").read_text())
    noxfile = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "POLARS_VERSIONS" for t in node.targets)
    )
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    matrix = re.search(r"^\s+polars: \[(.*)\]$", workflow, re.MULTILINE)
    assert matrix is not None
    assert [v.strip().strip('"') for v in matrix.group(1).split(",")] == noxfile
