"""Adapter layer: all assumptions about polars internals live here.

Callback names and arity, MessagePack field names and the metrics handle
method are confined to this package so a polars change has one blast radius.
Nothing here may raise into user code.
"""

from __future__ import annotations

__all__ = ["ObserverFactory"]

from polars_telemetry.adapter.hook import ObserverFactory
