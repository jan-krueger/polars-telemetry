"""No text value leaves a redacted profile, however its quotes fall."""

from __future__ import annotations

import json
import random

import pytest

pytestmark = pytest.mark.e2e

pl = pytest.importorskip("polars")

from polars_telemetry import Config, Redaction, profile  # noqa: E402

PIECES = (
    '"',
    '",',
    '")',
    '"]',
    '".',
    '" &',
    '" ==',
    '" |',
    ")",
    "(",
    "[",
    "]",
    ",",
    " ",
    "\\",
    "col(",
    'col("s")',
    "ü",
    "⚡",
    "\n",
    "&",
    "==",
)
FRAME = pl.LazyFrame({"s": ["a"], "t": ["b"]})


def _profiles(expression) -> str:
    with profile(Config(redaction=Redaction())) as session:
        FRAME.filter(expression).collect()
    return json.dumps(list(session.profiles()), ensure_ascii=False)


@pytest.mark.parametrize(
    "value",
    ['x", zq7SECRET', 'x") & (zq7SECRET', 'x".zq7SECRET', 'x" == zq7SECRET', 'col("s") zq7SECRET'],
)
def test_a_value_shaped_to_end_early_stays_masked(value):
    assert "zq7SECRET" not in _profiles(pl.col("s") == value)


def test_random_values_with_quotes_never_leak():
    rng = random.Random(0)  # noqa: S311
    leaked = []
    for case in range(200):
        markers = [(f"q{case}v{i}x", f"k{case}v{i}z") for i in range(2)]
        values = [
            head + "".join(rng.choice(PIECES) for _ in range(rng.randint(1, 6))) + tail
            for head, tail in markers
        ]
        text = _profiles(
            (pl.col("s") == values[0]) & (pl.col("t").str.contains(values[1], literal=True))
        )
        leaked += [marker for pair in markers for marker in pair if marker in text]
    assert leaked == []
