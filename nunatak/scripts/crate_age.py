"""Usage: crate_age.py check | crate_age.py newest NAME..."""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "target" / "crate-dates.json"
MIN_AGE = timedelta(days=7)
AGENT = "polars-telemetry nunatak crate-age check (https://github.com/jan-krueger/polars-telemetry)"

_last = 0.0


def _get(url: str) -> dict:
    global _last
    time.sleep(max(0.0, 1.0 - (time.monotonic() - _last)))
    _last = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})  # noqa: S310
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
        return json.load(response)


def _cache() -> dict[str, str]:
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def _save(cache: dict[str, str]) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, indent=0, sort_keys=True))


def published(name: str, version: str, cache: dict[str, str]) -> datetime:
    key = f"{name}@{version}"
    if key not in cache:
        cache[key] = _get(f"https://crates.io/api/v1/crates/{name}/{version}")["version"][
            "created_at"
        ]
    return datetime.fromisoformat(cache[key])


def check() -> int:
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text())
    cache = _cache()
    cutoff = datetime.now(UTC) - MIN_AGE
    young = []
    registry = [p for p in lock["package"] if p.get("source", "").startswith("registry+")]
    try:
        for package in registry:
            when = published(package["name"], package["version"], cache)
            if when > cutoff:
                young.append(f"{package['name']} {package['version']} ({when:%Y-%m-%d})")
    finally:
        _save(cache)
    if young:
        print("crate-age: younger than 7 days:\n  " + "\n  ".join(young))
        return 1
    print(f"crate-age: {len(registry)} locked crates, none younger than 7 days")
    return 0


def newest(names: list[str]) -> int:
    cutoff = datetime.now(UTC) - MIN_AGE
    for name in names:
        versions = _get(f"https://crates.io/api/v1/crates/{name}/versions")["versions"]
        fit = [
            v
            for v in versions
            if not v["yanked"]
            and "-" not in v["num"]
            and datetime.fromisoformat(v["created_at"]) <= cutoff
        ]
        found = f"{fit[0]['num']} ({fit[0]['created_at'][:10]})" if fit else "none"
        print(f"{name} {found}")
    return 0


if __name__ == "__main__":
    command, *rest = sys.argv[1:] or ["check"]
    sys.exit(check() if command == "check" else newest(rest))
