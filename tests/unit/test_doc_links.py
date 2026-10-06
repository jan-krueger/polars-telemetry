"""Addresses the code and the README link to must exist in the docs."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from polars_telemetry.model.insights.rules import RULES

ROOT = Path(__file__).parents[2]
SITE = "https://jan-krueger.github.io/polars-telemetry/"
_SITE_LINK = re.compile(re.escape(SITE) + r"([^\s\"'`)<>]*)")


def _slug(heading: str) -> str:
    text = re.sub(r"[`*_]", lambda m: "_" if m.group(0) == "_" else "", heading.strip().lower())
    text = re.sub(r"[^\w\- ]", "", text)
    return re.sub(r"[\s]+", "-", text)


def _page(path: str) -> Path | None:
    path = path.strip("/")
    for candidate in (ROOT / "docs" / f"{path}.md", ROOT / "docs" / path / "index.md"):
        if candidate.is_file():
            return candidate
    return None


def _anchors(page: Path) -> set[str]:
    return {_slug(m.group(1)) for m in re.finditer(r"^#{1,6} (.+)$", page.read_text(), re.M)}


def _linked() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    sources = [
        ROOT / "README.md",
        *(ROOT / "viewer" / "src").rglob("*.[jt]s*"),
        *(ROOT / "src").rglob("*.py"),
    ]
    for source in sources:
        for match in _SITE_LINK.finditer(source.read_text()):
            found.append((str(source.relative_to(ROOT)), match.group(1)))
    found += [("viewer/src/lib/insights.ts", f"insights/#{rule.id}") for rule in RULES]
    return found


@pytest.mark.parametrize(("source", "target"), _linked(), ids=lambda v: str(v))
def test_every_linked_docs_address_resolves(source: str, target: str) -> None:
    path, _, anchor = target.partition("#")
    if path.strip("/") == "viewer":
        assert (ROOT / "viewer" / "index.html").is_file()
        return
    page = _page(path) if path.strip("/") else ROOT / "docs" / "index.md"
    assert page is not None, f"{source} links to {SITE}{target}, which is no docs page"
    if anchor:
        assert anchor in _anchors(page), f"{source} links to #{anchor}, which {page.name} lacks"
