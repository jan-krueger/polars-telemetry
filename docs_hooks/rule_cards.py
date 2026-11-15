"""Renders each ```rule block of the docs as the same card; a malformed one fails the build."""

from __future__ import annotations

import re
from typing import Any

import yaml
from mkdocs.exceptions import PluginError

FIELDS = {
    "fires": "Fires on",
    "why": "Why it costs",
    "impact": "Impact",
    "fix": "Fix",
    "measured": "Measured",
    "notes": "Notes",
}
REQUIRED = ("fires", "fix")
FENCE = re.compile(r"^```rule\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)


def on_page_markdown(markdown: str, page: Any, **_: Any) -> str:
    return FENCE.sub(lambda match: card(match.group(1), page.file.src_uri), markdown)


def card(source: str, where: str) -> str:
    fields = yaml.safe_load(source) or {}
    if not isinstance(fields, dict):
        raise PluginError(f"{where}: a rule card is a mapping of fields")
    unknown = sorted(set(fields) - set(FIELDS))
    missing = [name for name in REQUIRED if not fields.get(name)]
    wrong = sorted(name for name, value in fields.items() if not isinstance(value, str))
    if unknown or missing or wrong:
        raise PluginError(
            f"{where}: rule card with unknown fields {unknown}, missing {missing}, "
            f"not text {wrong}; fields are {list(FIELDS)}"
        )
    rows = [
        f'<div class="rule-label rule-{name}">{label}</div>\n'
        f'<div class="rule-body rule-{name}" markdown="block">\n\n{fields[name].strip()}\n\n</div>'
        for name, label in FIELDS.items()
        if name in fields
    ]
    return '<div class="rule-card" markdown="block">\n\n' + "\n\n".join(rows) + "\n\n</div>\n"
