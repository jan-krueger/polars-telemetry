"""Every node kind polars emits for ordinary operations has a role.

The golden fixture is one query, so it sees a handful of kinds; this runs the
common operations against the installed polars. In the nightly canary it is
the tripwire for a renamed or newly introduced operator.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from polars_telemetry import profile
from polars_telemetry.model.types import NodeRole

pytestmark = [pytest.mark.contract, pytest.mark.live]

pl = pytest.importorskip("polars")


@pytest.fixture(scope="module")
def source(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("vocab") / "t.parquet"
    pl.DataFrame(
        {"a": [1, 2, 2, 3], "b": ["x", "y", "y", "z"], "l": [[1, 2], [3], [], [4]]}
    ).write_parquet(path)
    return path


def _operations(f: Path) -> dict[str, Callable[[], Any]]:
    def lf() -> Any:
        return pl.scan_parquet(f)

    return {
        "filter": lambda: lf().filter(pl.col("a") > 1),
        "select": lambda: lf().select("a"),
        "with_columns": lambda: lf().with_columns(c=pl.col("a") * 2),
        "rename": lambda: lf().rename({"a": "aa"}),
        "row_index": lambda: lf().with_row_index(),
        "explode": lambda: lf().explode("l"),
        "head": lambda: lf().head(2),
        "slice": lambda: lf().slice(1, 2),
        "unique": lambda: lf().unique(),
        "drop_nulls": lambda: lf().drop_nulls(),
        "sort": lambda: lf().sort("a"),
        "top_k": lambda: lf().sort("a").head(2),
        "group_by": lambda: lf().group_by("b").agg(pl.col("a").sum()),
        "global_agg": lambda: lf().select(pl.col("a").sum()),
        "join": lambda: lf().join(lf(), on="a"),
        "semi": lambda: lf().join(lf(), on="a", how="semi"),
        "anti": lambda: lf().join(lf(), on="a", how="anti"),
        "cross": lambda: lf().join(lf(), how="cross"),
        "join_asof": lambda: lf().sort("a").join_asof(lf().sort("a"), on="a"),
        "join_where": lambda: lf().join_where(lf(), pl.col("a") < pl.col("a_right")),
        "concat": lambda: pl.concat([lf(), lf()]),
        "concat_horizontal": lambda: pl.concat(
            [lf().select("a"), lf().select(c="b")], how="horizontal"
        ),
        "shift": lambda: lf().shift(1),
        "reverse": lambda: lf().reverse(),
        "gather_every": lambda: lf().gather_every(2),
        "interpolate": lambda: lf().select(pl.col("a").cast(pl.Float64)).interpolate(),
        "map_batches": lambda: lf().map_batches(lambda frame: frame),
    }


def test_every_operation_maps_to_known_roles(source: Path) -> None:
    unknown: dict[str, set[str]] = {}
    for name, build in _operations(source).items():
        with profile() as session:
            build().collect()
        for query in session:
            for plan in (query.logical, query.plan):
                for node in plan.values():
                    if node.role is NodeRole.UNKNOWN:
                        unknown.setdefault(node.kind, set()).add(name)
    assert unknown == {}, f"node kinds without a role: {unknown}"
