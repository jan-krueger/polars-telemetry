"""Managing the ``polars_cloud`` module polars resolves the factory from.

polars imports ``polars_cloud`` and reads ``QueryCloudObserver`` off it by
name. If the real package is installed we take over that attribute and keep the
original as a delegate; otherwise we register a module under that name. We
never ship a distribution called ``polars_cloud``.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from dataclasses import dataclass
from typing import Any

MODULE_NAME = "polars_cloud"
FACTORY_ATTR = "QueryCloudObserver"


@dataclass(frozen=True, slots=True)
class Binding:
    """What we found and what we replaced, so uninstall can undo it."""

    module: types.ModuleType
    previous_factory: Any | None
    """The real polars-cloud factory, when the package was already installed."""

    injected: bool
    """True when we created the module rather than finding it."""


def _real_package_available() -> bool:
    try:
        return importlib.util.find_spec(MODULE_NAME) is not None
    except (ImportError, ValueError):
        return False


def bind() -> Binding:
    """Make a ``polars_cloud`` module exist, returning what was there before."""
    if MODULE_NAME in sys.modules or _real_package_available():
        module = __import__(MODULE_NAME)
        return Binding(
            module=module,
            previous_factory=getattr(module, FACTORY_ATTR, None),
            injected=False,
        )

    module = types.ModuleType(MODULE_NAME)
    module.__version__ = "0.0.0+polars-telemetry"  # type: ignore[attr-defined]
    # polars calls authenticate() before it reads the factory.
    module.authenticate = lambda *args, **kwargs: None  # type: ignore[attr-defined]
    sys.modules[MODULE_NAME] = module
    return Binding(module=module, previous_factory=None, injected=True)


def set_factory(binding: Binding, factory: Any) -> None:
    setattr(binding.module, FACTORY_ATTR, factory)


def unbind(binding: Binding) -> None:
    """Restore whatever was there before :func:`bind`."""
    if binding.injected:
        sys.modules.pop(MODULE_NAME, None)
        return
    if binding.previous_factory is None:
        if hasattr(binding.module, FACTORY_ATTR):
            delattr(binding.module, FACTORY_ATTR)
    else:
        setattr(binding.module, FACTORY_ATTR, binding.previous_factory)
