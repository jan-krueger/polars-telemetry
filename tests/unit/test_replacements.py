from __future__ import annotations

import pytest

from polars_telemetry.adapter.replacements import groups, literal_step

STREETS = [
    ("straße", "str."),
    ("strasse", "str."),
    ("ß", "ss"),
    ("ü", "ue"),
    ("ö", "oe"),
    ("ä", "ae"),
    (" ", ""),
    ("-", ""),
    ("'", ""),
    (".", ""),
    (",", ""),
    ("(", ""),
    (")", ""),
]


@pytest.mark.parametrize(
    ("steps", "expected"),
    [
        (STREETS, 2),
        ([("a", "b"), ("c", "d")], 1),
        ([("a", "b"), ("b", "c")], 2),
        ([("a", "b"), ("bc", "x")], 2),
        ([("ab", "x"), ("b", "y")], 2),
        ([("ab", "x"), ("bc", "y")], 2),
        ([("-", ""), ("ab", "x")], 2),
        ([("-", ""), ("a", "x")], 1),
    ],
)
def test_steps_merge_only_while_one_pass_gives_the_same_result(steps, expected):
    assert groups(steps) == expected


@pytest.mark.parametrize(
    ("text", "step"),
    [
        ('(["straße", "str."])', ("straße", "str.")),
        ('(["\\.", ""])', (".", "")),
        ('(["\\(", ""])', ("(", "")),
        ('(["\\d", ""])', None),
        ('(["a", "$1"])', None),
        ('(["a", "b", "c"])', None),
        ('([col("p"), "x"])', None),
    ],
)
def test_reads_the_literal_from_polars_text(text, step):
    assert literal_step(text) == step
