"""Where in your code a query was run.

A plan fingerprint identifies a query shape but is a hash, and it changes when
polars changes its optimiser. A file and line does not, and a person can act
on it.
"""

from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import dataclass
from typing import TYPE_CHECKING

import polars

if TYPE_CHECKING:
    from types import FrameType

# The two package directories, with a trailing separator so that `polars` does
# not also skip a `polars_helpers` installed beside it. Taking the parent of
# this package instead would skip all of site-packages once installed.
_SKIP: tuple[str, ...] = (
    os.path.dirname(os.path.abspath(polars.__file__)) + os.sep,
    os.path.dirname(os.path.abspath(__file__)) + os.sep,
)

# Code with no file on disk: exec/eval and the REPL use <angle brackets>, and
# ipykernel writes each cell to the system temp directory under a name that
# changes every run. Neither names something a reader could open.
_SYNTHETIC: tuple[str, ...] = ("<", os.path.join(tempfile.gettempdir(), "ipykernel_"))


@dataclass(frozen=True, slots=True)
class CallSite:
    """The innermost frame outside polars and this package."""

    filepath: str
    lineno: int
    function: str


def _is_synthetic(path: str) -> bool:
    return path.startswith(_SYNTHETIC)


def caller() -> CallSite | None:
    """The user frame that ran the query, or None when there is no useful one.

    Walks out of polars and this package. Costs well under a microsecond, so it
    runs per query rather than being sampled.
    """
    frame: FrameType | None = sys._getframe(1)
    while frame is not None:
        path = frame.f_code.co_filename
        if not path.startswith(_SKIP):
            if _is_synthetic(path):
                return None
            return CallSite(path, frame.f_lineno, frame.f_code.co_name)
        frame = frame.f_back
    return None
