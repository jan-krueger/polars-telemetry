"""Every fix a rule gives, run on the installed polars.

The slow query gets the finding, the fixed one does not, and the fixed one
returns what the slow one meant to. A polars release that breaks a fix, or
makes it pointless, fails here instead of shipping wrong advice.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

pytestmark = [
    pytest.mark.contract,
    pytest.mark.live,
    pytest.mark.filterwarnings("ignore::polars.exceptions.PolarsInefficientMapWarning"),
    pytest.mark.filterwarnings("ignore:the default behavior of `how='horizontal'`"),
]

pl = pytest.importorskip("polars")

from polars.testing import assert_frame_equal  # noqa: E402

import polars_telemetry  # noqa: E402

Build = Callable[[Path], Any]


@dataclass(frozen=True)
class Fix:
    rule: str
    slow: Build
    fixed: Build
    intended: Build | None = None
    """What the slow query meant to return, when its own result is wrong."""
    slow_flags: dict[str, Any] = field(default_factory=dict)
    fixed_flags: dict[str, Any] = field(default_factory=dict)
    since: tuple[int, int] = (1, 0)
    until: tuple[int, int] = (99, 0)


def _version() -> tuple[int, int]:
    major, minor = pl.__version__.split(".")[:2]
    return int(major), int(minor)


def _no_cse() -> dict[str, Any]:
    return {"optimizations": pl.QueryOptFlags(comm_subplan_elim=False)}


def _ints(n: int) -> Any:
    return pl.int_range(n, eager=True)


def _orders() -> Any:
    i = _ints(20_000)
    return pl.LazyFrame({"cid": i % 500, "amount": i})


def _customers(copies: int) -> Any:
    one = pl.DataFrame({"cid": _ints(500), "seg": "a"})
    return pl.concat([one] * copies).lazy()


def _events_windows() -> tuple[Any, Any]:
    i, n = _ints(20_000), 200
    events = pl.LazyFrame({"id": i % n, "t": i % 1000})
    windows = pl.LazyFrame({"wid": _ints(n), "start": _ints(n) * 2, "end": _ints(n) * 2 + 500})
    return events, windows


def _in_range() -> list[Any]:
    return [pl.col("t") >= pl.col("start"), pl.col("t") < pl.col("end")]


def _reordered_joins(_: Path) -> Any:
    n_ent, n_day = 200, 60
    ent = _ints(n_ent)
    skeleton = (
        pl.DataFrame({"day": _ints(n_day)})
        .with_columns(ts=pl.col("day"))
        .join(pl.DataFrame({"id": ent}), how="cross")
    )
    id_map = pl.DataFrame({"id": ent, "tk": ent, "known_from": 0, "valid_from": 0})
    ents = pl.DataFrame({"ent": ent, "tk": ent})

    def chain() -> Any:
        return (
            skeleton.lazy()
            .join(id_map.lazy(), on="id")
            .filter(pl.col("known_from") <= pl.col("ts"))
            .filter(pl.col("valid_from") <= pl.col("day"))
            .join(ents.lazy(), on="tk")
        )

    per = (
        chain()
        .group_by(pl.col("ent").alias("id"), "ts", "day")
        .agg(v=pl.len())
        .rename({"id": "ent"})
    )
    return chain().select("id", "ts", "day", "ent").join(per, on=["ent", "ts", "day"])


def _quantiles(once: bool) -> Build:
    def build(_: Path) -> Any:
        i = _ints(50_000)
        lf = pl.LazyFrame(
            {"price": (i * 7919 % 10007).cast(pl.Float64), "size": i * 104729 % 999 + 1}
        )
        qs = [k / 10 for k in range(10)]
        value = pl.col("price") * pl.col("size")
        if not once:
            return lf.select(
                [value.quantile(q).alias(f"-{q}") for q in qs]
                + [(value <= value.quantile(q)).sum().alias(f"+{q}") for q in qs]
            )
        t = pl.col("tv")
        return (
            lf.with_columns(tv=value)
            .with_columns([t.quantile(q).alias(f"q{q}") for q in qs])
            .select(
                [pl.col(f"q{q}").first().alias(f"-{q}") for q in qs]
                + [(t <= pl.col(f"q{q}")).sum().alias(f"+{q}") for q in qs]
            )
        )

    return build


def _branches(cached: bool) -> Build:
    def build(tmp: Path) -> Any:
        base = pl.scan_parquet(tmp / "wide.parquet").filter(pl.col("v") % 3 == 0)
        base = base.with_columns(w=pl.col("v") * 2)
        if cached:
            base = base.cache()
        return pl.concat(
            [base.group_by("k").agg(pl.col("w").sum()), base.group_by("k").agg(pl.col("w").max())]
        )

    return build


def _distance(once: bool) -> Build:
    def build(_: Path) -> Any:
        i = _ints(300)
        points = pl.LazyFrame(
            {
                "lat": (i * 7919 % 18000).cast(pl.Float64) / 100 - 90,
                "lon": (i * 104729 % 36000).cast(pl.Float64) / 100 - 180,
            }
        )
        lat1, lat2 = pl.col("lat").radians(), pl.col("lat_right").radians()
        dlon = (pl.col("lon_right") - pl.col("lon")).radians()
        a = ((lat2 - lat1) / 2).sin() ** 2 + lat1.cos() * lat2.cos() * (dlon / 2).sin() ** 2
        distance = 2 * 6371 * a.sqrt().arcsin()
        if once:
            pairs = points.join(points, how="cross").with_columns(km=distance)
            return pairs.filter(pl.col("km") == pl.col("km").max())
        return points.join_where(points, distance == distance.max()).with_columns(km=distance)

    return build


WORDS = ["alpha", "beta", "gamma", "delta"]


def _words() -> Any:
    i = _ints(20_000)
    return pl.LazyFrame(
        {"s": pl.Series(["alpha one", "beta two", "x gamma", "plain", "delta y"])[i % 5]}
    )


def _dates() -> Any:
    return pl.LazyFrame({"d": [f"2024-01-{day % 28 + 1:02d} 12:00:00" for day in range(2_000)]})


def _extra() -> Any:
    return pl.LazyFrame({"D": _ints(200_000)})


FIXES = {
    "exploding_join: unique(subset=keys)": Fix(
        "exploding_join",
        slow=lambda _: (
            _orders().join(_customers(10), on="cid").group_by("seg").agg(pl.col("amount").sum())
        ),
        fixed=lambda _: (
            _orders()
            .join(_customers(10).unique(subset="cid"), on="cid")
            .group_by("seg")
            .agg(pl.col("amount").sum())
        ),
        intended=lambda _: (
            _orders().join(_customers(1), on="cid").group_by("seg").agg(pl.col("amount").sum())
        ),
    ),
    "exploding_join: equality key in join_where": Fix(
        "exploding_join",
        slow=lambda _: _events_windows()[0].join_where(_events_windows()[1], *_in_range()),
        fixed=lambda _: _events_windows()[0].join_where(
            _events_windows()[1], pl.col("id") == pl.col("wid"), *_in_range()
        ),
        intended=lambda _: (
            _events_windows()[0]
            .join_where(_events_windows()[1], *_in_range())
            .filter(pl.col("id") == pl.col("wid"))
        ),
    ),
    "exploding_join: join_order=False": Fix(
        "exploding_join",
        slow=_reordered_joins,
        fixed=_reordered_joins,
        fixed_flags={"optimizations": "join_order=False"},
        since=(2, 0),
        until=(2, 2),
    ),
    "cross_join: join_where comparing columns": Fix(
        "cross_join",
        slow=lambda _: (
            pl.LazyFrame({"x": _ints(800)})
            .join(pl.LazyFrame({"y": _ints(800)}), how="cross")
            .filter((pl.col("x") - pl.col("y")).abs() < 3)
        ),
        fixed=lambda _: pl.LazyFrame({"x": _ints(800)}).join_where(
            pl.LazyFrame({"y": _ints(800)}),
            pl.col("x") > pl.col("y") - 3,
            pl.col("x") < pl.col("y") + 3,
        ),
    ),
    "repeated_string_scan: contains_any": Fix(
        "repeated_string_scan",
        slow=lambda _: _words().filter(
            pl.any_horizontal(pl.col("s").str.contains(w, literal=True) for w in WORDS)
        ),
        fixed=lambda _: _words().filter(pl.col("s").str.contains_any(WORDS)),
    ),
    "repeated_string_scan: replace_many": Fix(
        "repeated_string_scan",
        slow=lambda _: _words().with_columns(
            pl.col("s")
            .str.replace_all("alpha", "A", literal=True)
            .str.replace_all("beta", "B", literal=True)
            .str.replace_all("gamma", "G", literal=True)
            .str.replace_all("delta", "D", literal=True)
        ),
        fixed=lambda _: _words().with_columns(
            pl.col("s").str.replace_many(WORDS, ["A", "B", "G", "D"])
        ),
    ),
    "redundant_aggregation: drop the unique": Fix(
        "redundant_aggregation",
        slow=lambda _: pl.LazyFrame({"id": _ints(20_000), "v": _ints(20_000) * 2}).unique(),
        fixed=lambda _: pl.LazyFrame({"id": _ints(20_000), "v": _ints(20_000) * 2}),
    ),
    "python_udf: native expression": Fix(
        "python_udf",
        slow=lambda _: pl.LazyFrame({"v": _ints(2_000)}).select(
            pl.col("v").map_elements(lambda v: v * 2, return_dtype=pl.Int64)
        ),
        fixed=lambda _: pl.LazyFrame({"v": _ints(2_000)}).select(pl.col("v") * 2),
    ),
    "datetime_format_inferred: format=": Fix(
        "datetime_format_inferred",
        slow=lambda _: _dates().select(pl.col("d").str.to_datetime()),
        fixed=lambda _: _dates().select(pl.col("d").str.to_datetime("%Y-%m-%d %H:%M:%S")),
    ),
    "repeated_subplan: with_columns": Fix(
        "repeated_subplan", slow=_quantiles(once=False), fixed=_quantiles(once=True)
    ),
    "repeated_subplan: cache": Fix(
        "repeated_subplan",
        slow=_branches(cached=False),
        fixed=_branches(cached=True),
        slow_flags={"optimizations": "no_cse"},
        fixed_flags={"optimizations": "no_cse"},
    ),
    "filter_after_scan: filter before the cast": Fix(
        "filter_after_scan",
        slow=lambda tmp: (
            pl.scan_parquet(tmp / "narrow.parquet").cast({"a": pl.UInt64}).filter(pl.col("a") > 990)
        ),
        fixed=lambda tmp: (
            pl.scan_parquet(tmp / "narrow.parquet").filter(pl.col("a") > 990).cast({"a": pl.UInt64})
        ),
    ),
    "filter_after_scan: row index and join": Fix(
        "filter_after_scan",
        slow=lambda tmp: (
            pl.concat([pl.scan_parquet(tmp / "narrow.parquet"), _extra()], how="horizontal")
            .filter(pl.col("a") == 42)
            .select(pl.col("b", "D").sum())
        ),
        fixed=lambda tmp: (
            pl.scan_parquet(tmp / "narrow.parquet")
            .with_row_index("i")
            .join(_extra().with_row_index("i"), on="i")
            .filter(pl.col("a") == 42)
            .select(pl.col("b", "D").sum())
        ),
    ),
    "repeated_expression: with_columns": Fix(
        "repeated_expression", slow=_distance(once=False), fixed=_distance(once=True)
    ),
}


@pytest.fixture(scope="module")
def tmp(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("fixes")
    i = _ints(200_000)
    pl.DataFrame({"a": i * 7919 % 1000, "b": i}).write_parquet(
        path / "narrow.parquet", row_group_size=50_000
    )
    pl.DataFrame({"k": i % 1000, "v": i}).write_parquet(path / "wide.parquet")
    return path


def _flags(flags: dict[str, Any]) -> dict[str, Any]:
    named = {
        "join_order=False": lambda: {"optimizations": pl.QueryOptFlags(join_order=False)},
        "no_cse": _no_cse,
    }
    return named[flags["optimizations"]]() if flags else {}


def _run(query: Any, flags: dict[str, Any]) -> tuple[Any, set[str]]:
    with polars_telemetry.profile() as session:
        result = query.collect(**_flags(flags))
    return result, {f.rule for q in session for f in q.insights or ()}


@pytest.mark.parametrize("name", list(FIXES))
def test_the_fix_clears_the_finding_and_returns_the_intended_result(name: str, tmp: Path) -> None:
    fix = FIXES[name]
    if _version() < fix.since:
        pytest.skip(f"the fix applies from polars {'.'.join(map(str, fix.since))}")
    if _version() >= fix.until:
        pytest.skip(f"polars {'.'.join(map(str, fix.until))} no longer needs the fix")
    slow, slow_rules = _run(fix.slow(tmp), fix.slow_flags)
    fixed, fixed_rules = _run(fix.fixed(tmp), fix.fixed_flags)
    assert fix.rule in slow_rules, f"{fix.rule} no longer fires on the slow query"
    assert fix.rule not in fixed_rules, f"{fix.rule} still fires after its fix"
    intended = fix.intended(tmp).collect() if fix.intended else slow
    assert_frame_equal(fixed, intended, check_row_order=False)
