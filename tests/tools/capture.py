"""Capture the raw observer payloads from the installed polars.

Deliberately independent of polars_telemetry.adapter: fixtures are ground
truth, so they must not be filtered through the code they are used to test.

    python tests/tools/capture.py [outdir]
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

import msgpack

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures"

captured: dict[str, Any] = {}


class _Guard:
    def __init__(self, handle: Any) -> None:
        self._handle = handle

    def close(self) -> None:
        captured["metrics"] = self._handle.snapshot_query_metrics()


class _Observer:
    def on_query_started(self, query_id: Any) -> None:
        captured["query_id"] = str(query_id)

    def on_query_planned(
        self, query_id: Any, handle: Any, ir_plan: bytes, physical_plan: bytes
    ) -> _Guard:
        captured["ir"] = ir_plan
        captured["physical"] = physical_plan
        return _Guard(handle)

    def on_query_failed(self, *args: Any) -> None:
        captured["failed"] = repr(args)


def _install_shim() -> None:
    module = types.ModuleType("polars_cloud")
    module.__version__ = "0.0.0-capture"  # type: ignore[attr-defined]
    module.authenticate = lambda *a, **k: None  # type: ignore[attr-defined]
    module.QueryCloudObserver = lambda workspace=None, organization=None: _Observer()  # type: ignore[attr-defined]
    sys.modules["polars_cloud"] = module


def _run_capture_query(pl: Any) -> None:
    """A query shaped to cover the node kinds we care about.

    Scan with predicate pushdown, join, projection, aggregation, sort, sink.
    Sources are written into the cwd under fixed names so ``first_source`` is
    stable across machines.
    """
    pl.DataFrame(
        {
            "order_id": list(range(2000)),
            "customer_id": [i % 50 for i in range(2000)],
            "amount": [float(i % 97) for i in range(2000)],
            "qty": [(i % 5) + 1 for i in range(2000)],
        }
    ).write_parquet("orders.parquet")
    pl.DataFrame({"customer_id": list(range(50)), "segment": ["a", "b"] * 25}).write_parquet(
        "customers.parquet"
    )

    (
        pl.scan_parquet("orders.parquet")
        .filter(pl.col("amount") > 10)
        .join(pl.scan_parquet("customers.parquet"), on="customer_id", how="inner")
        .with_columns((pl.col("amount") * pl.col("qty")).alias("revenue"))
        .group_by("segment")
        .agg(pl.col("revenue").sum(), pl.col("order_id").count())
        .sort("segment")
        .collect(engine="streaming")
    )


def main(argv: list[str]) -> int:
    _install_shim()
    import polars as pl

    version = pl.__version__
    out = Path(argv[1]).resolve() if len(argv) > 1 else FIXTURE_ROOT / version

    pl.Config.enable_monitoring()

    origin = Path.cwd()
    workdir = Path(tempfile.mkdtemp(prefix="polars-telemetry-capture-"))
    try:
        os.chdir(workdir)
        _run_capture_query(pl)
    finally:
        os.chdir(origin)
        shutil.rmtree(workdir, ignore_errors=True)

    missing = {"ir", "physical", "metrics"} - captured.keys()
    if missing:
        print(f"capture incomplete, missing: {sorted(missing)}", file=sys.stderr)
        return 1

    out.mkdir(parents=True, exist_ok=True)
    for name in ("ir", "physical", "metrics"):
        blob: bytes = captured[name]
        (out / f"{name}.msgpack").write_bytes(blob)
        decoded = msgpack.unpackb(blob, raw=False, strict_map_key=False)
        (out / f"{name}.json").write_text(json.dumps(decoded, indent=1, sort_keys=True) + "\n")

    (out / "meta.json").write_text(
        json.dumps(
            {
                "polars_version": version,
                "python_version": ".".join(str(p) for p in sys.version_info[:3]),
                "capture_script": "tests/tools/capture.py",
            },
            indent=1,
            sort_keys=True,
        )
        + "\n"
    )
    print(f"captured polars {version} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
