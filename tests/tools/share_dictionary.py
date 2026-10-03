"""Build a dictionary for the viewer's share links, as a new version.

    uv run python tests/tools/share_dictionary.py 2

A released dictionary is never changed: links made with it must keep opening.
A new one gets the next version number, and the viewer keeps every version.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from polars_telemetry.adapter.dialect import _BY_KIND

ROOT = Path(__file__).parents[2]
WINDOW = 32_768


def _compact(document: object) -> str:
    return json.dumps(document, separators=(",", ":"))


def build() -> str:
    """One example node of every kind, a profile's skeleton, then two whole profiles."""
    profiles = [
        json.loads(line)
        for scale in (1, 10)
        for line in (ROOT / "examples" / f"tpch-sf{scale}.jsonl").read_text().splitlines()
    ]
    seen: set[str] = set()
    nodes: list[dict[str, Any]] = []
    for profile in profiles:
        for side in ("logical", "physical"):
            for node in profile["plan"][side]:
                if node["kind"] not in seen:
                    seen.add(node["kind"])
                    nodes.append(node)
    metrics = next(
        node["metrics"] for p in profiles for node in p["plan"]["physical"] if node.get("metrics")
    )
    for kind, role in _BY_KIND.items():
        if kind not in seen:
            nodes.append(
                {
                    "id": 4294967297,
                    "kind": kind,
                    "role": role.value,
                    "inputs": [4294967298],
                    "properties": {"type": kind},
                    "metrics": metrics,
                }
            )
    skeleton = {**profiles[0], "plan": {"physical": [], "logical": []}}
    q9 = next(p for p in profiles if p["label"] == "tpch/q9")
    text = _compact(skeleton) + "".join(map(_compact, nodes)) + _compact(profiles[0]) + _compact(q9)
    return text[-WINDOW:]


def main() -> None:
    version = int(sys.argv[1])
    out = ROOT / "viewer" / "src" / "share" / f"dictionary-{version}.txt"
    if out.exists():
        sys.exit(f"{out.name} is released and must not change; build version {version + 1}")
    out.write_text(build())
    print(f"wrote {out.relative_to(ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
