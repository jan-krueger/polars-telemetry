// The contract test checks this against what the exporter writes.

export type Unit = "rows" | "ns" | "bytes" | "count";

export interface Counter {
  key: string;
  label: string;
  unit: Unit;
  /** IO counters are all zero for in-memory work; the group hides together. */
  group?: "io";
  /** The largest value seen so far, not a running total. */
  peak?: true;
}

export const COUNTERS: readonly Counter[] = [
  { key: "rows_received", label: "Rows in", unit: "rows" },
  { key: "rows_sent", label: "Rows out", unit: "rows" },
  { key: "morsels_received", label: "Morsels received", unit: "count" },
  { key: "morsels_sent", label: "Morsels sent", unit: "count" },
  { key: "largest_morsel_received", label: "Largest morsel received", unit: "rows", peak: true },
  { key: "largest_morsel_sent", label: "Largest morsel sent", unit: "rows", peak: true },
  { key: "total_time_ns", label: "Total time", unit: "ns" },
  { key: "total_poll_time_ns", label: "Total poll time", unit: "ns" },
  { key: "max_poll_time_ns", label: "Maximum poll time", unit: "ns", peak: true },
  { key: "total_polls", label: "Total number of polls", unit: "count" },
  { key: "total_stolen_polls", label: "Total polls stolen", unit: "count" },
  { key: "total_state_update_time_ns", label: "Total state update time", unit: "ns" },
  { key: "max_state_update_time_ns", label: "Maximum state update time", unit: "ns", peak: true },
  { key: "total_state_updates", label: "Number state updates", unit: "count" },
  { key: "io_total_active_ns", label: "IO active time", unit: "ns", group: "io" },
  { key: "io_total_bytes_received", label: "IO bytes received", unit: "bytes", group: "io" },
  { key: "io_total_bytes_requested", label: "IO bytes requested", unit: "bytes", group: "io" },
  { key: "io_total_bytes_sent", label: "IO bytes sent", unit: "bytes", group: "io" },
];

export const PEAKS: ReadonlySet<string> = new Set(COUNTERS.filter((c) => c.peak).map((c) => c.key));

/** A group shows if any member is non-zero. */
export function visibleCounters(metrics: Record<string, unknown>): Counter[] {
  const groupActive = (group: Counter["group"]) =>
    COUNTERS.some((c) => c.group === group && Number(metrics[c.key]) > 0);
  return COUNTERS.filter(
    (c) => metrics[c.key] != null && (c.group === undefined || groupActive(c.group)),
  );
}
