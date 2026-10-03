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

from typing import TYPE_CHECKING, TypedDict

from polars_telemetry.model.types import (
    JOIN_ROLES,
    AggregationFacet,
    JoinFacet,
    NodeRole,
    ScanFacet,
    SortFacet,
)

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


class Facets(TypedDict, total=False):
    """Keyword arguments for PlanNode: at most one facet, matching the role."""

    scan: ScanFacet
    join: JoinFacet
    sort: SortFacet
    aggregation: AggregationFacet


def facets(role: NodeRole, properties: Mapping[str, object]) -> Facets:
    """The normalised view of a node's properties, keyed by PlanNode field."""
    if role is NodeRole.SCAN:
        return {"scan": _scan(properties)}
    if role in JOIN_ROLES:
        return {"join": _join(properties)}
    if role is NodeRole.SORT:
        return {"sort": _sort(properties)}
    if role is NodeRole.AGGREGATION:
        return {"aggregation": _aggregation(properties)}
    return {}


def _count(value: object) -> int | None:
    return len(value) if isinstance(value, list) else None


def _flag(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _scan(p: Mapping[str, object]) -> ScanFacet:
    predicate = p.get("predicate")
    if isinstance(predicate, list):
        predicates = tuple(str(item) for item in predicate)
    elif predicate is not None:
        predicates = (str(predicate),)
    else:
        predicates = ()
    source = p.get("first_source")
    return ScanFacet(
        source=source if isinstance(source, str) else None,
        predicates=predicates,
        predicate_pushed=predicate is not None,
        columns_read=_count(p.get("projected_file_columns") or p.get("projection")),
        file_columns=_count(p.get("file_columns")),
        row_groups_skipped=_flag(p.get("predicate_file_skip_applied")),
        has_statistics=_flag(p.get("has_table_statistics")),
    )


def _join(p: Mapping[str, object]) -> JoinFacet:
    how = p.get("how")
    left_on = p.get("left_on")
    return JoinFacet(
        how=how if isinstance(how, str) else None,
        left_keys=tuple(str(key) for key in left_on) if isinstance(left_on, list) else (),
    )


def _sort(p: Mapping[str, object]) -> SortFacet:
    specs = p.get("sort_columns")
    columns = (
        tuple(str(spec["expr"]) for spec in specs if isinstance(spec, dict) and "expr" in spec)
        if isinstance(specs, list)
        else ()
    )
    return SortFacet(columns=columns)


def _aggregation(p: Mapping[str, object]) -> AggregationFacet:
    # The IR has a flat `keys`; the physical plan nests them under
    # `key_per_input`, renamed to _POLARS_TMP_N. Neither means a global reduction.
    keys = p.get("keys")
    if isinstance(keys, list):
        return AggregationFacet(keys=tuple(str(key) for key in keys), grouped=True)
    nested = p.get("key_per_input")
    if isinstance(nested, list):
        flat = tuple(str(key) for group in nested if isinstance(group, list) for key in group)
        return AggregationFacet(keys=flat, grouped=True)
    return AggregationFacet()
