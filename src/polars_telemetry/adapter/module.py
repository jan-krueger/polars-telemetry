"""Managing the module polars resolves the factory from.

polars imports ``polars_cloud`` (``polars_nanook`` once polars prefers it,
pola-rs/polars#30099) and reads ``QueryCloudObserver`` off it by name. If the
real package is installed we take over that attribute and keep the original as
a delegate; otherwise we register a module under that name. We never ship a
distribution under either name.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from dataclasses import dataclass
from typing import Any

DEFAULT_MODULE_NAME = "polars_cloud"
FACTORY_ATTR = "QueryCloudObserver"


@dataclass(frozen=True, slots=True)
class Binding:
    """What we found and what we replaced, so uninstall can undo it."""

    name: str
    module: types.ModuleType
    previous_factory: Any | None
    """The real polars-cloud factory, when the package was already installed."""

    injected: bool
    """True when we created the module rather than finding it."""


def module_name() -> str:
    """The name polars imports the factory from, as polars resolved it."""
    try:
        from polars import _dependencies
    except ImportError:
        return DEFAULT_MODULE_NAME
    name = getattr(getattr(_dependencies, "polars_cloud", None), "__name__", None)
    return name if isinstance(name, str) else DEFAULT_MODULE_NAME


def _real_package_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def bind() -> Binding:
    """Make the factory module exist, returning what was there before."""
    name = module_name()
    if name in sys.modules or _real_package_available(name):
        module = importlib.import_module(name)
        return Binding(
            name=name,
            module=module,
            previous_factory=getattr(module, FACTORY_ATTR, None),
            injected=False,
        )

    module = types.ModuleType(name)
    module.__version__ = "0.0.0+polars-telemetry"  # type: ignore[attr-defined]
    # polars calls authenticate() before it reads the factory.
    module.authenticate = lambda *args, **kwargs: None  # type: ignore[attr-defined]
    sys.modules[name] = module
    return Binding(name=name, module=module, previous_factory=None, injected=True)


def set_factory(binding: Binding, factory: Any) -> None:
    setattr(binding.module, FACTORY_ATTR, factory)


def unbind(binding: Binding) -> None:
    """Restore whatever was there before :func:`bind`."""
    if binding.injected:
        sys.modules.pop(binding.name, None)
        return
    if binding.previous_factory is None:
        if hasattr(binding.module, FACTORY_ATTR):
            delattr(binding.module, FACTORY_ATTR)
    else:
        setattr(binding.module, FACTORY_ATTR, binding.previous_factory)
