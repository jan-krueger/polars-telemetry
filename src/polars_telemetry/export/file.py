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


class FileExporter:
    """Append one profile per query to a `.jsonl` file the viewer can open.

    Args:
        path: The session file. Its directory is created if missing.
        max_bytes: 64 MiB by default. When the file would grow past this,
            it moves to `<name>.1`, replacing the previous one, and a new file
            starts. At most about twice this is on disk. A profile is never
            split, so a file can run over by one record.
    """

    __slots__ = ("_errors", "_lock", "_max_bytes", "_path")

    def __init__(
        self,
        path: str | Path,
        *,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        if max_bytes <= 0:
            msg = f"max_bytes must be positive, got {max_bytes}"
            raise ValueError(msg)
        self._path = Path(path)
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._errors = 0
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        """The file being written."""
        return self._path

    def export(self, query: Query) -> None:
        try:
            document = build_profile(query)
            line = profile_line(document)
        except Exception as exc:
            self._record(exc, "building the profile")
            return

        with self._lock:
            try:
                self._rotate_if_needed(len(line) + 1)
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            except Exception as exc:
                self._record(exc, f"writing to {self._path}")

    def _rotate_if_needed(self, incoming: int) -> None:
        try:
            current = self._path.stat().st_size
        except FileNotFoundError:
            return
        if current + incoming <= self._max_bytes:
            return
        os.replace(self._path, self._path.with_suffix(self._path.suffix + ".1"))

    def _record(self, exc: Exception, doing: str) -> None:
        self._errors += 1
        if self._errors == 1:
            _log.warning(
                "polars-telemetry: profile export failed while %s (%s: %s). "
                "Queries are unaffected.",
                doing,
                type(exc).__name__,
                exc,
            )

    @property
    def errors(self) -> int:
        return self._errors
