"""OpenTelemetry instrumentation for Polars query execution.

Activation is always explicit::

    import polars_telemetry
    polars_telemetry.install()

It is never automatic on import: enabling monitoring sets polars' engine
affinity to ``"streaming"``, which changes how the user's queries execute.
That is not a side effect an import may have.
"""

from __future__ import annotations

__version__ = "0.0.0"

__all__ = ["Config", "SamplingMode", "__version__", "install", "uninstall"]

from polars_telemetry.activation import install, uninstall
from polars_telemetry.config import Config, SamplingMode
