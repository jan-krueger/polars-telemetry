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
  PythonScan: "scan",
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
  Slice: "function",
  DynamicSlice: "function",
  NegativeSlice: "function",
  Gather: "function",
  CumAgg: "function",
  Ewm: "function",
  ForwardFill: "function",
  BackwardFill: "function",
  PeakMax: "function",
  PeakMin: "function",
  Repeat: "function",
  Rle: "function",
  RleId: "function",
  IsSorted: "function",
  IsFirstDistinct: "function",
  StrptimeInfer: "function",
  Window: "function",
  RollingFixedWindowFunction: "function",
  EquiJoin: "join",
  IEJoin: "theta_join",
  RangeJoin: "theta_join",
  AsOfJoin: "theta_join",
  CrossJoin: "cross_join",
  SemiAntiJoin: "semi_anti_join",
  InMemoryJoin: "join",
  MergeJoin: "join",
  InMemoryIEJoin: "theta_join",
  InMemoryAsOfJoin: "theta_join",
  GroupBy: "aggregation",
  Reduce: "aggregation",
  SortedGroupBy: "aggregation",
  RollingGroupBy: "aggregation",
  DynamicGroupBy: "aggregation",
  Sort: "sort",
  TopK: "top_k",
  Distinct: "distinct",
  SortedUnique: "distinct",
  Union: "union",
  UnorderedUnion: "union",
  OrderedUnion: "union",
  MergeSorted: "union",
  Sink: "sink",
  InMemorySink: "sink",
  IoSink: "sink",
  PartitionSink: "sink",
  FileSink: "sink",
  CallbackSink: "sink",
  SinkMultiple: "sink",
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

/** A path's last part, whichever separator the writing machine used. */
export const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** The relation a scan reads: the file name, without its directory. */
export function relationName(properties: Record<string, unknown>): string {
  const source = properties.first_source;
  return typeof source === "string" ? basename(source) : "";
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

/** Expressions this short read better on one line than broken up. */
const CHAIN_WIDTH = 36;
/** A condition already has a line to itself, so it can run a little longer. */
const CONDITION_WIDTH = 48;

/**
 * A polars expression split into one line per method call, the way it would be
 * written: `col("a").sum().alias("b")` becomes `col("a")`, `  .sum()`,
 * `  .alias("b")`. Breaks only at a dot that follows a call's closing
 * parenthesis outside any brackets or string, so namespaces (`.dt.year()`)
 * and nested expressions stay whole. A line that is still too wide is left
 * for the reader to scroll, never split mid-token.
 */
export function chainLines(expr: string, width = CHAIN_WIDTH): string[] {
  if (expr.length <= width) return [expr];
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      line += ch;
      if (ch === "\\" && i + 1 < expr.length) line += expr[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "." && depth === 0 && line.trimEnd().endsWith(")")) {
      lines.push(line);
      line = "  .";
      continue;
    }
    line += ch;
  }
  lines.push(line);
  return lines;
}

type Op = "&" | "|";

interface Scanned {
  text: string;
  /** For each opening bracket, where it closes; -1 elsewhere. */
  closes: Int32Array;
  /** Positions of each operator, by the bracket depth it sits at. */
  ops: Map<number, Record<Op, number[]>>;
}

/** polars prints strings unescaped: one ends at a quote that can be followed
 *  by the end, a closing bracket, a comma, a dot or a binary operator. */
const STRING_END = /^(?:$|[)\],.]| [&|=!<>+\-*\/%])/;

function scan(text: string): Scanned {
  const closes = new Int32Array(text.length).fill(-1);
  const ops = new Map<number, Record<Op, number[]>>();
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = text.indexOf(ch, i + 1);
      while (j !== -1 && !STRING_END.test(text.slice(j + 1, j + 3))) j = text.indexOf(ch, j + 1);
      i = j === -1 ? text.length : j;
    } else if (ch === "(" || ch === "[") open.push(i);
    else if (ch === ")" || ch === "]") {
      const from = open.pop();
      if (from !== undefined) closes[from] = i;
    } else if ((ch === "&" || ch === "|") && text[i - 1] === " " && text[i + 1] === " ") {
      const depth = open.length;
      if (!ops.has(depth)) ops.set(depth, { "&": [], "|": [] });
      ops.get(depth)![ch].push(i);
    }
  }
  return { text, closes, ops };
}

/** The first index in sorted `values` that is at least `target`. */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Condition = string | { op: Op; terms: Condition[]; length: number; text: () => string };

type Range = [lo: number, hi: number, depth: number];

/** `(a & b)` → `a & b`, as often as the whole range is one parenthesis. */
function unwrap(s: Scanned, [lo, hi, depth]: Range): Range {
  for (;;) {
    while (lo < hi && s.text[lo] === " ") lo++;
    while (hi > lo && s.text[hi - 1] === " ") hi--;
    if (s.text[lo] !== "(" || s.closes[lo] !== hi - 1) return [lo, hi, depth];
    lo++;
    hi--;
    depth++;
  }
}

/** Where `op` splits the range at its top level. */
function cutsOf(s: Scanned, [lo, hi, depth]: Range, op: Op): number[] {
  const all = s.ops.get(depth)?.[op] ?? [];
  return all.slice(lowerBound(all, lo), lowerBound(all, hi));
}

function parts([lo, hi, depth]: Range, cuts: number[]): Range[] {
  const bounds = [lo, ...cuts.map((c) => c + 1), hi];
  return cuts.map((cut, k) => [bounds[k]!, cut, depth] as Range).concat([[bounds[cuts.length]!, hi, depth]]);
}

/** Split at the top-level `|`, else `&`; `|` binds loosest. A run of one
 *  operator, which polars nests a pair at a time, is flattened in a loop. */
function condition(s: Scanned, range: Range): Condition {
  const whole = unwrap(s, range);
  for (const op of ["|", "&"] as const) {
    const cuts = cutsOf(s, whole, op);
    if (!cuts.length) continue;
    const terms: Condition[] = [];
    const pending = parts(whole, cuts).reverse();
    while (pending.length) {
      const part = unwrap(s, pending.pop()!);
      const inner = cutsOf(s, part, op);
      if (inner.length) pending.push(...parts(part, inner).reverse());
      else terms.push(condition(s, part));
    }
    const [lo, hi] = whole;
    return { op, terms, length: hi - lo, text: () => s.text.slice(lo, hi) };
  }
  return s.text.slice(whole[0], whole[1]);
}

function conditionLines(c: Condition): string[] {
  if (typeof c === "string") return chainLines(c, CONDITION_WIDTH);
  if (c.length <= CHAIN_WIDTH) return [c.text()];
  const lines: string[] = [];
  c.terms.forEach((term, k) => {
    let sub = conditionLines(term);
    // A group of the other operator keeps its parentheses, opening where the
    // operator column is, so its own operators line up beneath them.
    if (typeof term !== "string" && sub.length > 1)
      sub = sub.map((line, j) => (j === 0 ? `(${line.slice(1)}` : line)).map((line, j, all) =>
        j === all.length - 1 ? `${line})` : line);
    else if (typeof term !== "string") sub = [`(${sub[0]})`];
    sub.forEach((line, j) => lines.push(j > 0 ? `  ${line}` : k > 0 ? `${c.op} ${line}` : `  ${line}`));
  });
  return lines;
}

/**
 * An expression laid out to read: one condition per line where it combines
 * conditions with `&` and `|`, otherwise one method call per line. polars
 * parenthesises every pair of conditions; only the parentheses that change
 * the meaning are kept.
 */
/** One predicate from the conditions polars lists separately, all of which must hold. */
export const conjunction = (conditions: string[]): string =>
  conditions.length === 1 ? conditions[0]! : conditions.map((c) => `(${c})`).join(" & ");

export function exprLines(expr: string): string[] {
  let lines = laidOut.get(expr);
  if (!lines) {
    lines = conditionLines(condition(scan(expr), [0, expr.length, 0]));
    if (laidOut.size >= 500) laidOut.clear();
    laidOut.set(expr, lines);
  }
  return lines;
}

const laidOut = new Map<string, string[]>();
