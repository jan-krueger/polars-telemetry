/**
 * polars' plan vocabulary, interpreted in one place.
 *
 * Profiles carry each node's `role` — the stable, relational-algebra name for
 * what it does — assigned on the Python side. Files written before that field
 * existed only carry polars' own kind names, so `roleOf` falls back to a table
 * that mirrors the Python dialect; a test keeps the two in step.
 */

export type Role =
  | "scan"
  | "dataframe"
  | "selection"
  | "projection"
  | "map"
  | "rename"
  | "function"
  | "join"
  | "theta_join"
  | "cross_join"
  | "semi_anti_join"
  | "aggregation"
  | "sort"
  | "top_k"
  | "distinct"
  | "union"
  | "sink"
  | "engine"
  | "unknown";

export interface RawNode {
  id: number;
  kind: string;
  role?: string;
  inputs: number[];
  properties?: Record<string, unknown>;
}

interface RoleInfo {
  /** Relational-algebra symbol; empty for relations, which are shown by name. */
  symbol: string;
  name: string;
  /** Plumbing or output rather than an operator on your data: drawn muted. */
  muted?: boolean;
}

export const ROLES: Record<Role, RoleInfo> = {
  scan: { symbol: "", name: "relation (file scan)" },
  dataframe: { symbol: "", name: "relation (in-memory frame)" },
  selection: { symbol: "σ", name: "selection — keeps the rows that match" },
  projection: { symbol: "π", name: "projection — keeps or replaces columns" },
  map: { symbol: "χ", name: "map — adds computed columns, keeps the rest" },
  rename: { symbol: "ρ", name: "rename" },
  function: { symbol: "λ", name: "function over the frame (explode, unpivot, a UDF)" },
  join: { symbol: "⋈", name: "join on equal keys" },
  theta_join: { symbol: "⋈θ", name: "join on an inequality" },
  cross_join: { symbol: "×", name: "cross product" },
  semi_anti_join: { symbol: "⋉", name: "semi or anti join — the physical plan does not say which" },
  aggregation: { symbol: "γ", name: "grouping and aggregation" },
  sort: { symbol: "τ", name: "sort" },
  top_k: { symbol: "τₖ", name: "top-k — sort with a limit" },
  distinct: { symbol: "δ", name: "duplicate elimination" },
  union: { symbol: "⊎", name: "union — duplicates kept" },
  sink: { symbol: "⤓", name: "where the result goes", muted: true },
  engine: { symbol: "◦", name: "streaming-engine plumbing", muted: true },
  unknown: { symbol: "?", name: "a node kind this viewer does not recognise", muted: true },
};

// Mirrors polars_telemetry/adapter/dialect.py for profiles that predate `role`.
const BY_KIND: Record<string, Role> = {
  Scan: "scan",
  MultiScan: "scan",
  DataFrameScan: "dataframe",
  InMemorySource: "dataframe",
  Filter: "selection",
  SimpleProjection: "projection",
  InputIndependentSelect: "projection",
  HStack: "map",
  WithRowIndex: "map",
  MapFunction: "function",
  Map: "function",
  InMemoryMap: "function",
  HConcat: "function",
  Shift: "function",
  ColumnarFunction: "function",
  GatherEvery: "function",
  Interpolate: "function",
  EquiJoin: "join",
  IEJoin: "theta_join",
  RangeJoin: "theta_join",
  AsOfJoin: "theta_join",
  CrossJoin: "cross_join",
  SemiAntiJoin: "semi_anti_join",
  GroupBy: "aggregation",
  Reduce: "aggregation",
  Sort: "sort",
  TopK: "top_k",
  Distinct: "distinct",
  Union: "union",
  UnorderedUnion: "union",
  OrderedUnion: "union",
  Sink: "sink",
  InMemorySink: "sink",
  IoSink: "sink",
  PartitionSink: "sink",
  FileSink: "sink",
  Multiplexer: "engine",
  Cache: "engine",
  Zip: "engine",
};

const isRole = (value: unknown): value is Role =>
  typeof value === "string" && Object.hasOwn(ROLES, value);

/** The role the profile states, else one derived the way the dialect would. */
export function roleOf(node: RawNode): Role {
  if (isRole(node.role)) return node.role;
  return derivedRole(node);
}

export function derivedRole(node: Pick<RawNode, "kind" | "properties">): Role {
  const p = node.properties ?? {};
  if (node.kind === "Join") {
    const how = typeof p.how === "string" ? p.how.toUpperCase() : "";
    return how === "SEMI" || how === "ANTI" ? "semi_anti_join" : "join";
  }
  if (node.kind === "Select") return p.extend_original === true ? "map" : "projection";
  if (node.kind === "MapFunction" && typeof p.function === "string"
      && p.function.toUpperCase().startsWith("RENAME")) {
    return "rename";
  }
  return BY_KIND[node.kind] ?? "unknown";
}

/**
 * The column an expression names: `col("region")` → `region`. Anything else —
 * a computed expression, a repr polars has changed — comes back as written,
 * never empty and never throwing.
 */
export function exprColumn(expr: unknown): string {
  const text = String(expr ?? "");
  const match = /^col\("((?:[^"\\]|\\.)*)"\)$/.exec(text);
  return match?.[1] ?? text;
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Grouping keys: a flat `keys` in the IR, `key_per_input` in the physical plan. */
export function groupKeys(properties: Record<string, unknown>): string[] {
  const flat = asList(properties.keys);
  const nested = asList(properties.key_per_input).flatMap(asList);
  return (flat.length ? flat : nested).map(exprColumn);
}

/** The relation a scan reads: the file name, without its directory. */
export function relationName(properties: Record<string, unknown>): string {
  const source = properties.first_source;
  return typeof source === "string" ? source.split("/").pop() ?? source : "";
}

/** The short parameter shown under a node: its keys, columns or source. */
export function nodeLabel(node: RawNode): string {
  const p = node.properties ?? {};
  const role = roleOf(node);
  // The title already names the relation, so only pushdown is worth adding.
  if (role === "scan") return p.predicate ? "pushdown" : "";
  if (role === "aggregation") return groupKeys(p).join(", ");
  if (role === "join") return typeof p.how === "string" ? p.how : "";
  if (role === "sort") {
    const first = asList(p.sort_columns)[0] as { expr?: unknown } | undefined;
    return first ? exprColumn(first.expr) : "";
  }
  if (role === "projection" || role === "map") {
    const columns = asList(p.columns);
    return columns.length ? `${columns.length} cols` : "";
  }
  if (role === "function" && typeof p.function === "string") return p.function;
  return "";
}
