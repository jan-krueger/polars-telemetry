"""polars' plan vocabulary, translated into roles.

The only place outside payload decoding that knows polars' node kind names.
The IR and the physical plan name the same operators differently -- `Join`
against `EquiJoin`, `Scan` against `MultiScan` -- and either can change in a
release, so both are mapped here onto `NodeRole` and nothing downstream
compares kind strings.

A kind missing from these tables becomes `NodeRole.UNKNOWN` and is reported by
`unknown_kinds`, so a rename shows up in the probe and the contract tests
instead of silently emptying every attribute that depended on it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from polars_telemetry.model.types import NodeRole

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

_BY_KIND: dict[str, NodeRole] = {
    # sources
    "Scan": NodeRole.SCAN,
    "MultiScan": NodeRole.SCAN,
    "DataFrameScan": NodeRole.DATAFRAME,
    "InMemorySource": NodeRole.DATAFRAME,
    # row and column operators
    "Filter": NodeRole.SELECTION,
    "SimpleProjection": NodeRole.PROJECTION,
    "InputIndependentSelect": NodeRole.PROJECTION,
    "HStack": NodeRole.MAP,
    "WithRowIndex": NodeRole.MAP,
    "MapFunction": NodeRole.FUNCTION,
    "Map": NodeRole.FUNCTION,
    "InMemoryMap": NodeRole.FUNCTION,
    "HConcat": NodeRole.FUNCTION,
    "Shift": NodeRole.FUNCTION,
    "ColumnarFunction": NodeRole.FUNCTION,
    "GatherEvery": NodeRole.FUNCTION,
    "Interpolate": NodeRole.FUNCTION,
    # joins
    "EquiJoin": NodeRole.JOIN,
    "IEJoin": NodeRole.THETA_JOIN,
    "RangeJoin": NodeRole.THETA_JOIN,
    "AsOfJoin": NodeRole.THETA_JOIN,
    "CrossJoin": NodeRole.CROSS_JOIN,
    "SemiAntiJoin": NodeRole.SEMI_ANTI_JOIN,
    # aggregation, ordering, sets
    "GroupBy": NodeRole.AGGREGATION,
    "Reduce": NodeRole.AGGREGATION,
    "Sort": NodeRole.SORT,
    "TopK": NodeRole.TOP_K,
    "Distinct": NodeRole.DISTINCT,
    "Union": NodeRole.UNION,
    "UnorderedUnion": NodeRole.UNION,
    "OrderedUnion": NodeRole.UNION,
    # outputs and plumbing
    "Sink": NodeRole.SINK,
    "InMemorySink": NodeRole.SINK,
    "IoSink": NodeRole.SINK,
    "PartitionSink": NodeRole.SINK,
    "FileSink": NodeRole.SINK,
    "Multiplexer": NodeRole.ENGINE,
    "Cache": NodeRole.ENGINE,
    "Zip": NodeRole.ENGINE,
}

# Kinds whose role depends on a property, not the kind alone; see `role_of`.
_RULED = frozenset({"Join", "Select", "MapFunction"})
_IR_SEMI_ANTI = frozenset({"SEMI", "ANTI"})


def role_of(kind: str, properties: Mapping[str, object]) -> NodeRole:
    """What a node of this kind, with these properties, does."""
    if kind == "Join":
        # The IR folds semi and anti joins into `Join`; the physical plan does not.
        how = properties.get("how")
        if isinstance(how, str) and how.upper() in _IR_SEMI_ANTI:
            return NodeRole.SEMI_ANTI_JOIN
        return NodeRole.JOIN
    if kind == "Select":
        # with_columns keeps the frame and adds to it; select replaces it.
        return NodeRole.MAP if properties.get("extend_original") is True else NodeRole.PROJECTION
    if kind == "MapFunction":
        function = properties.get("function")
        if isinstance(function, str) and function.upper().startswith("RENAME"):
            return NodeRole.RENAME
    return _BY_KIND.get(kind, NodeRole.UNKNOWN)


def unknown_kinds(kinds: Iterable[str]) -> list[str]:
    """Kinds the tables above do not recognise. Reportable, never fatal."""
    return sorted({kind for kind in kinds if kind not in _BY_KIND and kind not in _RULED})
