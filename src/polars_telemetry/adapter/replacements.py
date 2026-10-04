"""How few `str.replace_many` calls can stand in for a chain of literal replacements.

`replace_many` scans its input once: it never sees its own output, and of two
patterns matching at one place it picks one. A chain run step by step does
both differently, so steps merge only while neither can matter.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

_ESCAPED = re.compile(r"\\(.)", re.DOTALL)

Step = tuple[str, str]


def literal_step(arguments: str) -> Step | None:
    """Pattern and replacement from polars' `str.replace(["p", "r"])` text.

    polars writes both unescaped, so a step is read only when the text splits
    one way. A regex that escapes punctuation matches what the punctuation
    would as a literal.
    """
    if not (arguments.startswith('(["') and arguments.endswith('"])')):
        return None
    parts = arguments[3:-3].split('", "')
    if len(parts) != 2 or "$" in parts[1] or "\\" in parts[1]:
        return None
    pattern = _plain(parts[0])
    return None if pattern is None else (pattern, parts[1])


def groups(steps: Sequence[Step]) -> int:
    """The fewest consecutive groups, each one `replace_many` call with the same result."""
    count, group = 0, list[Step]()
    for step in steps:
        if not group or not all(_independent(earlier, step) for earlier in group):
            count += 1
            group = []
        group.append(step)
    return count


def _independent(earlier: Step, later: Step) -> bool:
    (first, made), (second, _) = earlier, later
    if not first or not second:
        return False
    if first in second or second in first or _overlaps(first, second) or _overlaps(second, first):
        return False
    if not made:
        return len(second) == 1
    return (
        made not in second
        and second not in made
        and not _overlaps(made, second)
        and not _overlaps(second, made)
    )


def _overlaps(left: str, right: str) -> bool:
    """A proper suffix of `left` is a proper prefix of `right`: one match can run into the other."""
    return any(left.endswith(right[:size]) for size in range(1, min(len(left), len(right))))


def _plain(pattern: str) -> str | None:
    """The literal a pattern stands for, or None when a backslash means more than that."""
    stripped = _ESCAPED.sub("", pattern)
    if "\\" in stripped:
        return None
    if any(c.isalnum() or c.isspace() for c in _ESCAPED.findall(pattern)):
        return None
    return _ESCAPED.sub(lambda m: m[1], pattern)
