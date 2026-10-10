export const SCHEMA_PREFIX = "polars-telemetry/profile@";
export const EVENTS_SCHEMA = "polars-telemetry/events@1";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
