"""What the entry pages claim must stay true: the snippets run, the versions
and options match the code, and prose states no counts that go stale."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

import pytest

from polars_telemetry import compat
from polars_telemetry.cli import _parser

ROOT = Path(__file__).parents[2]
QUICK_STARTS = (ROOT / "README.md", ROOT / "docs" / "getting-started.md")
PAGES = (ROOT / "README.md", ROOT / "CONTRIBUTING.md", *sorted((ROOT / "docs").rglob("*.md")))
COUNTED = re.compile(
    r"\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+) "
    r"(?:insight )?(?:rules|exporters|metrics|attributes|instruments|counters|histograms|"
    r"options)\b",
    re.IGNORECASE,
)


def _blocks(path: Path) -> list[tuple[str, str]]:
    return re.findall(r"```(\w+)\n(.*?)```", path.read_text(), re.DOTALL)


@pytest.mark.parametrize("path", list(QUICK_STARTS), ids=lambda path: path.name)
def test_quick_start_runs_as_shown(path, tmp_path):
    blocks = _blocks(path)
    ran = 0
    for index, (lang, code) in enumerate(blocks):
        if lang == "python" and "import polars_telemetry" in code:
            result = subprocess.run(  # noqa: S603
                [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True
            )
            assert result.returncode == 0, f"block {index}:\n{code}\n{result.stderr}"
            ran += 1
        elif lang == "console" and code.startswith("$ polars-telemetry "):
            command, *_, summary = code.strip().splitlines()
            result = subprocess.run(  # noqa: S603
                [sys.executable, "-m", "polars_telemetry.cli", *command.split()[2:]],
                cwd=tmp_path,
                capture_output=True,
                text=True,
            )
            assert result.stdout.strip().splitlines()[-1] == summary, result.stdout
            ran += 1
    assert ran >= 3


@pytest.mark.parametrize(
    "path",
    [ROOT / "README.md", ROOT / "docs" / "internals" / "compatibility.md"],
    ids=lambda path: path.name,
)
def test_supported_polars_versions_match_compat(path):
    lower = re.fullmatch(r">=([\d.]+),<(\d+)", compat.SUPPORTED)
    assert lower is not None, compat.SUPPORTED
    oldest, ceiling = lower.groups()
    text = path.read_text()
    assert f"Polars {oldest}" in text
    assert f"{int(ceiling) - 1}.x" in text


def test_every_cli_option_is_documented():
    commands = next(
        action for action in _parser()._actions if isinstance(action, argparse._SubParsersAction)
    )
    page = (ROOT / "docs" / "insights.md").read_text()
    table = "\n".join(line for line in page.splitlines() if line.startswith("| `--"))
    for action in commands.choices["insights"]._actions:
        for option in action.option_strings:
            if option in ("-h", "--help"):
                continue
            assert f"`{option}" in table, option
            for choice in action.choices or ():
                if choice != action.default:
                    assert f"`{option} {choice}`" in table, (option, choice)


@pytest.mark.parametrize("path", list(PAGES), ids=lambda path: str(path.relative_to(ROOT)))
def test_prose_states_no_counts(path):
    prose = re.sub(r"```.*?```", "", path.read_text(), flags=re.DOTALL)
    assert COUNTED.findall(prose) == []
