import { describe, expect, it } from "vitest";
import { tokenize } from "../src/lib/highlight";

const kinds = (code: string) => tokenize(code).filter((t) => t.kind !== "text").map((t) => `${t.kind}:${t.text}`);

describe("tokenize", () => {
  it("reads the setup snippet", () => {
    expect(kinds('from x import y\ninstall(exporter=F("p.jsonl"))')).toEqual([
      "keyword:from", "keyword:import", "call:install", "punct:(", "punct:=",
      "call:F", "punct:(", 'string:"p.jsonl"', "punct:))",
    ]);
  });

  it("reads a polars expression", () => {
    expect(kinds('col("a").sum().alias("b")').filter((k) => !k.startsWith("punct"))).toEqual([
      "call:col", 'string:"a"', "call:sum", "call:alias", 'string:"b"',
    ]);
  });

  it("never treats text inside a string as code", () => {
    expect(kinds('"from import col("')).toEqual(['string:"from import col("']);
  });

  it("round-trips every character", () => {
    const code = 'col("x") > 10.5 # \\"odd\\" ✓';
    expect(tokenize(code).map((t) => t.text).join("")).toBe(code);
  });
});
