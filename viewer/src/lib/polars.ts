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
  /** Empty for scans and frames, which have no operator symbol. */
  symbol: string;
  name: string;
  /** Plumbing, drawn muted. */
  muted?: boolean;
}

export const ROLES: Record<Role, RoleInfo> = {
  scan: { symbol: "", name: "scan" },
  dataframe: { symbol: "", name: "in-memory frame" },
  selection: { symbol: "σ", name: "selection" },
  projection: { symbol: "π", name: "projection" },
  map: { symbol: "χ", name: "extended projection" },
  rename: { symbol: "ρ", name: "rename" },
  function: { symbol: "λ", name: "function" },
  join: { symbol: "⋈", name: "equi-join" },
  theta_join: { symbol: "⋈θ", name: "theta join" },
  cross_join: { symbol: "×", name: "cross join" },
  semi_anti_join: { symbol: "⋉", name: "semi / anti join" },
  aggregation: { symbol: "γ", name: "aggregation" },
  sort: { symbol: "τ", name: "sort" },
  top_k: { symbol: "τₖ", name: "top-k" },
  distinct: { symbol: "δ", name: "distinct" },
  union: { symbol: "⊎", name: "union all" },
  sink: { symbol: "⤓", name: "sink", muted: true },
  engine: { symbol: "◦", name: "engine", muted: true },
  unknown: { symbol: "?", name: "unknown kind", muted: true },
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

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Either separator. */
export const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export function relationName(properties: Record<string, unknown>): string {
  const source = properties.first_source;
  return typeof source === "string" ? basename(source) : "";
}

const TEMP = /^_POLARS_TMP/;

const columnsIn = (expr: unknown): string[] =>
  [...String(expr ?? "").matchAll(/col\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]!);

/** `col("a") > 3` → `a > 3`. */
const plain = (expr: unknown): string => String(expr ?? "").replace(/col\("((?:[^"\\]|\\.)*)"\)/g, "$1");

const outputName = (expr: unknown): string | null =>
  /\.alias\("((?:[^"\\]|\\.)*)"\)$/.exec(String(expr))?.[1] ?? /^col\("((?:[^"\\]|\\.)*)"\)$/.exec(String(expr))?.[1] ?? null;

/** `a, b +3` */
const few = (names: string[], shown = 2): string =>
  names.length <= shown ? names.join(", ") : `${names.slice(0, shown).join(", ")} +${names.length - shown}`;

const counted = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A plain column's name; null for anything computed, including Polars' temporary columns. */
const named = (expr: unknown): string | null => {
  const text = String(expr ?? "");
  const name = /^col\("((?:[^"\\]|\\.)*)"\)$/.exec(text)?.[1] ?? (/^[\w.]+$/.test(text) ? text : null);
  return name && !TEMP.test(name) ? name : null;
};

/** Every column by name when the plan names them all, else only how many there are. */
function keyText(exprs: unknown[], word = "key"): string {
  const names = exprs.map(named);
  return names.every((n) => n !== null) ? few(names as string[]) : counted(exprs.length, word);
}

const lower = (value: unknown): string => (typeof value === "string" && value !== "None" ? value.toLowerCase() : "");

/** What kind of the operator this is, when it comes in kinds: `inner`, `parquet`. */
export function nodeVariant(node: RawNode): string {
  const p = node.properties ?? {};
  const role = roleOf(node);
  if (role === "scan") return lower(p.scan_type);
  if (role === "join" || role === "semi_anti_join") return lower(p.how);
  if (role === "sink") return lower(p.file_format);
  return "";
}

/** What the node works on: its source, keys, columns or condition. Empty when there is nothing to add. */
export function nodeSubject(node: RawNode): string {
  const p = node.properties ?? {};
  const role = roleOf(node);
  switch (role) {
    case "scan": {
      const more = Number(p.num_sources) > 1 ? ` +${counted(Number(p.num_sources) - 1, "file")}` : "";
      return relationName(p) + more;
    }
    case "aggregation": {
      if (node.kind === "Reduce") {
        const exprs = asList(p.exprs);
        const first = exprs[0];
        const call = /^col\("((?:[^"\\]|\\.)*)"\)\.(\w+)\(\)(?:\.alias\(.*\))?$/.exec(String(first));
        const column = call && !TEMP.test(call[1]!) ? call[1] : null;
        return column ? `${call![2]}(${column})${exprs.length > 1 ? ` +${exprs.length - 1}` : ""}` : counted(exprs.length, "expression");
      }
      const keys = asList(p.keys).length ? asList(p.keys) : asList(p.key_per_input).flatMap(asList);
      return keys.length ? `by ${keyText(keys)}` : "";
    }
    case "join": case "semi_anti_join": case "theta_join": {
      const left = asList(p.left_on).map(named);
      const right = asList(p.right_on).map(named);
      if (!left.length) return "";
      if (![...left, ...right].every((n) => n !== null)) return `on ${counted(left.length, "key")}`;
      if (left.join() === right.join()) return `on ${few(left as string[])}`;
      return `on ${left[0]} = ${right[0] ?? "…"}${left.length > 1 ? ` +${left.length - 1}` : ""}`;
    }
    case "sort": {
      const columns = asList(p.sort_columns) as { expr?: unknown; descending?: unknown }[];
      const names = columns.map((c) => named(c.expr));
      if (!columns.length) return "";
      if (!names.every((n) => n !== null)) return `by ${counted(columns.length, "key")}`;
      return `by ${few(names.map((n, i) => (columns[i]!.descending === true ? `${n} ↓` : n!)))}`;
    }
    case "top_k": {
      const by = asList(p.by_exprs);
      return by.length ? `by ${keyText(by)}` : "";
    }
    case "selection": {
      const conditions = Array.isArray(p.predicate) ? p.predicate : p.predicate ? [p.predicate] : [];
      const columns = conditions.flatMap(columnsIn);
      if (columns.some((c) => TEMP.test(c))) return "computed condition";
      if (conditions.some((c) => String(c).includes("dynamic_predicate"))) return `${few(columns)} · set while running`;
      return conditions.map(plain).join(" & ");
    }
    case "projection": case "map": {
      const exprs = asList(p.selectors).length ? asList(p.selectors) : asList(p.exprs);
      const names = exprs.map(outputName);
      if (!names.some((n) => n && !TEMP.test(n))) return "";
      const adds = p.extend_original === true || node.kind === "HStack" ? "adds " : "";
      return adds + (names.every((n) => n && !TEMP.test(n)) ? few(names as string[]) : counted(names.length, "column"));
    }
    case "function":
      if (node.kind === "Slice" && Number.isFinite(Number(p.offset)) && Number.isFinite(Number(p.length))) {
        return rows([p.offset, p.length]);
      }
      return typeof p.function === "string" ? p.function : "";
    case "sink": {
      const target = typeof p.target === "string" ? p.target : typeof p.dest === "string" && p.dest !== "Memory" ? p.dest : "";
      return target ? `→ ${basename(target)}` : "";
    }
    default:
      return "";
  }
}

export type MarkKind = "filter" | "columns" | "limit" | "skip";

export interface Mark {
  kind: MarkKind;
  name: string;
  detail: string;
}

const present = (value: unknown): boolean => value != null && value !== "None" && !(Array.isArray(value) && !value.length);

/** `[0, 100]` → `rows 0–100`; any other shape as written. */
function rows(slice: unknown): string {
  const [offset, length] = asList(slice).map(Number);
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return String(slice);
  return offset! < 0 ? `last ${-offset!} rows` : `rows ${offset}–${offset! + length!}`;
}

/** Work a node did not have to do: what was pushed into a scan, or a sort that keeps only some rows. */
export function nodeMarks(node: RawNode): Mark[] {
  const p = node.properties ?? {};
  const role = roleOf(node);
  const marks: Mark[] = [];
  if (role === "scan") {
    if (present(p.predicate)) {
      const conditions = Array.isArray(p.predicate) ? p.predicate : [p.predicate];
      const computed = conditions.flatMap(columnsIn).some((c) => TEMP.test(c));
      marks.push({ kind: "filter", name: "predicate pushdown", detail: computed ? "computed condition" : conditions.map(plain).join(" & ") });
    }
    const read = asList(p.projected_file_columns).length ? asList(p.projected_file_columns) : asList(p.projection);
    if (read.length) {
      const all = asList(p.file_columns).length;
      const named = read.map(String).filter((c) => !TEMP.test(c));
      marks.push({
        kind: "columns",
        name: "projection pushdown",
        detail: `${all ? `${read.length}/${all}` : read.length}${named.length ? `: ${named.join(", ")}` : ""}`,
      });
    }
    if (present(p.pre_slice)) marks.push({ kind: "limit", name: "slice pushdown", detail: rows(p.pre_slice) });
    if (p.predicate_file_skip_applied === true) {
      marks.push({ kind: "skip", name: "file skipping", detail: "statistics" });
    }
  }
  if (role === "sort" && (present(p.slice) || present(p.limit))) {
    marks.push({ kind: "limit", name: present(p.slice) ? "slice" : "limit", detail: present(p.slice) ? rows(p.slice) : `${String(p.limit)} rows` });
  }
  return marks;
}

const CHAIN_WIDTH = 36;
const CONDITION_WIDTH = 48;

/** One line per method call; breaks only after a top-level `)`, so `.dt.year()` stays whole. */
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
  closes: Int32Array;
  ops: Map<number, Record<Op, number[]>>;
}

/** polars prints strings unescaped: one ends at a quote followed by the end, `)`, `]`, `,`, `.` or an operator. */
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

function cutsOf(s: Scanned, [lo, hi, depth]: Range, op: Op): number[] {
  const all = s.ops.get(depth)?.[op] ?? [];
  return all.slice(lowerBound(all, lo), lowerBound(all, hi));
}

function parts([lo, hi, depth]: Range, cuts: number[]): Range[] {
  const bounds = [lo, ...cuts.map((c) => c + 1), hi];
  return cuts.map((cut, k) => [bounds[k]!, cut, depth] as Range).concat([[bounds[cuts.length]!, hi, depth]]);
}

/** `|` binds loosest; Polars nests runs pairwise, flattened here. */
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
    if (typeof term !== "string" && sub.length > 1)
      sub = sub.map((line, j) => (j === 0 ? `(${line.slice(1)}` : line)).map((line, j, all) =>
        j === all.length - 1 ? `${line})` : line);
    else if (typeof term !== "string") sub = [`(${sub[0]})`];
    sub.forEach((line, j) => lines.push(j > 0 ? `  ${line}` : k > 0 ? `${c.op} ${line}` : `  ${line}`));
  });
  return lines;
}

/** One condition per line, keeping only parentheses that change the meaning; else one call per line. */
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
