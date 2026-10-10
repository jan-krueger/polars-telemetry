"""Write one profile document per query to a JSON Lines file.

A session file rather than a file per query: comparing runs is the point, and
most interesting cases are "this job ran forty queries". Each line is complete
on its own, so the file can be truncated at any point and still parse.

Nothing here reaches the network. The file stays on the machine that produced
it, which is what makes it safe to keep plan literals at full fidelity.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from polars_telemetry.export.profile import build_profile, profile_line

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query

_log = logging.getLogger("polars_telemetry")

DEFAULT_MAX_BYTES = 64 * 1024 * 1024
"""Profiles run ~10 KB on a plan of a dozen nodes, so this is several thousand
queries before the first rotation."""


class RotatingFile:
    """A file that moves to `<name>.1` past `max_bytes` and reports its first failure."""

    __slots__ = ("errors", "max_bytes", "path", "what")

    def __init__(self, path: str | Path, max_bytes: int, what: str) -> None:
        if max_bytes <= 0:
            msg = f"max_bytes must be positive, got {max_bytes}"
            raise ValueError(msg)
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.what = what
        self.errors = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def rotate_if_needed(self, incoming: int) -> None:
        try:
            current = self.path.stat().st_size
        except FileNotFoundError:
            return
        if current + incoming <= self.max_bytes:
            return
        os.replace(self.path, self.path.with_name(self.path.name + ".1"))

    def record(self, exc: Exception, doing: str) -> None:
        self.errors += 1
        if self.errors == 1:
            _log.warning(
                "polars-telemetry: %s export failed while %s (%s: %s). Queries are unaffected.",
                self.what,
                doing,
                type(exc).__name__,
                exc,
            )


class FileExporter:
    """Append one profile per query to a `.jsonl` file the viewer can open.

    Args:
        path: The session file. Its directory is created if missing.
        max_bytes: 64 MiB by default. When the file would grow past this,
            it moves to `<name>.1`, replacing the previous one, and a new file
            starts. At most about twice this is on disk. A profile is never
            split, so a file can run over by one record.
    """

    __slots__ = ("_file", "_lock")

    def __init__(
        self,
        path: str | Path,
        *,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self._file = RotatingFile(path, max_bytes, "profile")
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        """The file being written."""
        return self._file.path

    def export(self, query: Query) -> None:
        try:
            document = build_profile(query)
            line = profile_line(document)
        except Exception as exc:
            self._file.record(exc, "building the profile")
            return

        with self._lock:
            try:
                self._file.rotate_if_needed(len(line) + 1)
                with self._file.path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            except Exception as exc:
                self._file.record(exc, f"writing to {self._file.path}")

    @property
    def errors(self) -> int:
        return self._file.errors
