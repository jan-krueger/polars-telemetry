"""Model types."""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from enum import Enum
from typing import TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from polars_telemetry.model.diagnostics import Diagnostics
    from polars_telemetry.model.insights.finding import Finding
    from polars_telemetry.model.redaction import Redaction


@dataclass(frozen=True, slots=True)
class CallSite:
    """The innermost frame outside polars and this package."""

    filepath: str
    lineno: int
    function: str


class NodeRole(str, Enum):
    """What a plan node does, in relational-algebra terms.

    The stable vocabulary: polars' own node kinds differ between the IR and the
    physical plan and can change in any release, so everything downstream of
    the adapter asks for a role rather than a kind name.
    """

    SCAN = "scan"
    """Reads a file or object-storage source."""
    DATAFRAME = "dataframe"
    """An in-memory frame as a relation."""
    SELECTION = "selection"
    """σ: drops rows."""
    PROJECTION = "projection"
    """π: keeps or replaces columns."""
    MAP = "map"
    """χ: adds computed columns, keeping the rest."""
    RENAME = "rename"
    """ρ."""
    FUNCTION = "function"
    """An opaque function over the frame: explode, unpivot, a UDF."""
    JOIN = "join"
    """⋈ on equal keys."""
    THETA_JOIN = "theta_join"
    """⋈θ on an inequality."""
    CROSS_JOIN = "cross_join"
    """×."""
    SEMI_ANTI_JOIN = "semi_anti_join"
    """⋉ or ▷; the physical plan does not say which."""
    AGGREGATION = "aggregation"
    """γ."""
    SORT = "sort"
    """τ."""
    TOP_K = "top_k"
    """τ with a limit."""
    DISTINCT = "distinct"
    """δ."""
    UNION = "union"
    """⊎: concatenation, duplicates kept."""
    SINK = "sink"
    """Where the result goes."""
    ENGINE = "engine"
    """Streaming-engine plumbing with no relational meaning."""
    UNKNOWN = "unknown"
    """A kind the adapter does not recognise."""


JOIN_ROLES: frozenset[NodeRole] = frozenset(
    {NodeRole.JOIN, NodeRole.THETA_JOIN, NodeRole.CROSS_JOIN, NodeRole.SEMI_ANTI_JOIN}
)


@dataclass(frozen=True, slots=True)
class ScanFacet:
    """What a scan reads, the same whichever plan it came from."""

    source: str | None = None
    predicates: tuple[str, ...] = ()
    """Pushed-down predicate text; the IR has a list, the physical plan one."""
    predicate_pushed: bool = False
    columns_read: int | None = None
    """Only the physical plan says; the IR reports the file's width instead."""
    file_columns: int | None = None
    """Only the IR says."""
    row_groups_skipped: bool | None = None
    has_statistics: bool | None = None


@dataclass(frozen=True, slots=True)
class JoinFacet:
    how: str | None = None
    left_keys: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SortFacet:
    columns: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AggregationFacet:
    keys: tuple[str, ...] = ()
    grouped: bool = False
    """False for a global reduction, which has no keys at all."""


@dataclass(frozen=True, slots=True)
class CallCount:
    """How often one function is applied to one input within a node."""

    function: str
    target: str
    """An opaque token for the column or expression it is applied to."""
    count: int


@dataclass(frozen=True, slots=True)
class NodeTraits:
    """How a node executes, read from polars' vocabulary by the adapter.

    Insight rules read these instead of kind names or expression text, which
    are polars' to change.
    """

    in_memory_fallback: bool = False
    """The streaming engine hands this node's whole input to the in-memory engine."""
    infers_datetime_format: bool = False
    python_udf: bool = False
    deduplicates: bool = False
    """The node only removes duplicate rows: a distinct, or a grouping whose
    aggregations each keep a value as it is."""
    asks_unique: bool = False
    """An expression of the node asks for unique values."""
    string_calls: tuple[CallCount, ...] = ()
    plugin_calls: tuple[CallCount, ...] = ()
    """Keyed by the whole call, input and arguments included: a count above one is
    the same computation repeated."""


@dataclass(frozen=True, slots=True)
class PlanNode:
    """One plan node."""

    node_id: int
    """polars' phys_node_key on the physical plan; metrics join on this."""

    kind: str
    """polars' own name for the node, kept for display and full fidelity."""

    inputs: tuple[int, ...]
    properties: dict[str, object]
    """Raw plan properties: scan source, predicate, join keys, aggregations."""

    role: NodeRole = NodeRole.UNKNOWN
    """What the node does. Read this, not `kind`."""

    # Normalised by the adapter's dialect for the roles that have one; read
    # these rather than `properties`, whose names are polars' to change.
    scan: ScanFacet | None = None
    join: JoinFacet | None = None
    sort: SortFacet | None = None
    aggregation: AggregationFacet | None = None
    traits: NodeTraits = NodeTraits()


@dataclass(frozen=True, slots=True)
class NodeMetrics:
    """Cumulative counters for one node at the end of the query."""

    node_id: int
    total_time_ns: int
    total_polls: int
    total_stolen_polls: int
    total_poll_time_ns: int
    max_poll_time_ns: int
    total_state_updates: int
    total_state_update_time_ns: int
    max_state_update_time_ns: int
    rows_received: int
    rows_sent: int
    morsels_received: int
    morsels_sent: int
    largest_morsel_received: int
    largest_morsel_sent: int
    io_total_active_ns: int
    io_total_bytes_received: int
    io_total_bytes_requested: int
    io_total_bytes_sent: int
    done: bool

    @property
    def cpu_ms(self) -> float:
        return self.total_time_ns / 1e6

    @property
    def stolen_ratio(self) -> float | None:
        return self.total_stolen_polls / self.total_polls if self.total_polls else None


COUNTER_NAMES: tuple[str, ...] = tuple(
    f.name for f in fields(NodeMetrics) if f.name not in {"node_id", "done"}
)
"""Every per-node counter, in one place: decoding, model construction and the
profile document all derive from this."""


@dataclass(frozen=True, slots=True)
class Query:
    """One finished query, as every exporter receives it."""

    query_id: UUID
    """polars' id for the query: a UUIDv7, so ids sort by start time."""
    wall_ms: float
    """Time from start to finish, in milliseconds."""
    plan: dict[int, PlanNode]
    """Physical plan, by node id; empty when the query did not run on the
    streaming engine. Node ids here are what `metrics` key on."""

    logical: dict[int, PlanNode] = field(default_factory=dict)
    """IR plan. Carries the user's own column names; the physical plan rewrites
    group-by keys and aggregations to _POLARS_TMP_N."""

    metrics: dict[int, NodeMetrics] = field(default_factory=dict)
    call_site: CallSite | None = None
    """Where in the caller's code the query ran."""

    label: str | None = None
    """What the application called it, via `polars_telemetry.label()`."""

    engine: str | None = None
    """The polars engine that ran it; None when it failed before planning."""

    polars_version: str = ""
    """The polars that ran it. Carried here so nothing downstream imports polars."""

    fingerprint: str = ""
    """The plan shape, hashed once on arrival; empty on a Query built by hand."""

    diagnostics: Diagnostics | None = None
    """Derived once on arrival, so every exporter reports the same figures."""

    failed: str | None = None
    """polars' error message when the query failed, else None."""
    redaction: Redaction | None = None
    """What was masked before this reached the exporter, else None."""
    started_unix_ns: int = 0
    """When the query started, in nanoseconds since the Unix epoch."""
    insights: tuple[Finding, ...] | None = None
    """Findings about the plan, most important first; None when not computed."""
    planning_ms: float | None = None
    """From the start to polars handing over the plan to run: optimisation and
    lowering. None when the query failed before planning."""
    telemetry_ms: float | None = None
    """polars-telemetry's own work before execution, within wall time."""

    @property
    def cpu_ms(self) -> float:
        """Summed node self time. Exceeds wall time on a parallel query."""
        return sum(node.total_time_ns for node in self.metrics.values()) / 1e6

    @property
    def parallelism(self) -> float:
        return self.cpu_ms / self.wall_ms if self.wall_ms > 0 else 0.0

    @property
    def result_rows(self) -> int | None:
        """Rows reaching the sink, when the sink reported any."""
        rows = [
            self.metrics[node_id].rows_received
            for node_id, node in self.plan.items()
            if node.role is NodeRole.SINK and node_id in self.metrics
        ]
        return sum(rows) if rows else None

    @property
    def hottest(self) -> tuple[PlanNode, NodeMetrics] | None:
        """The node with the most self time -- usually the whole answer."""
        if not self.metrics:
            return None
        node_id, metric = max(self.metrics.items(), key=lambda item: item[1].total_time_ns)
        node = self.plan.get(node_id)
        return (node, metric) if node is not None else None
