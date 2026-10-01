"""Layer 1 -- the quarantine.

Every assumption about polars' internals lives in this package and nowhere
else: callback names and arity, MessagePack field names, the metrics handle
method. When polars changes the contract, this directory is the only one that
should need edits.

Nothing here may raise into user code.
"""

from __future__ import annotations

__all__ = ["ObserverFactory"]

from polars_telemetry.adapter.observer import ObserverFactory
