import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_LINK_CHARS, isShareFragment, openShareFragment, shareFragment } from "../src/share/link";

const examples = readFileSync(new URL("../../examples/tpch-sf1.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

describe("share links", () => {
  it("carry profiles there and back unchanged", () => {
    const documents = examples.slice(0, 2);
    const fragment = shareFragment(documents);
    expect(isShareFragment(fragment)).toBe(true);
    expect(openShareFragment(fragment)).toEqual({ documents });
  });

  it("keep every TPC-H query, with a run to compare, within the length offered", () => {
    const longest = Math.max(...examples.map((_, i) => shareFragment(examples.slice(i, i + 2)).length));
    expect(longest).toBeLessThan(MAX_LINK_CHARS);
  });

  it("say why a link cannot be opened", () => {
    const fragment = shareFragment(examples.slice(0, 1));
    expect(openShareFragment(fragment.slice(0, fragment.length / 2))).toHaveProperty("problem");
    expect(openShareFragment("#share=99.abc")).toEqual({ problem: "this link was made by a newer viewer" });
    expect(isShareFragment("#s=session&q=query")).toBe(false);
  });

  it("never change a released dictionary, or its links stop opening", () => {
    const released = readFileSync(new URL("../src/share/dictionary-1.txt", import.meta.url));
    expect(createHash("sha256").update(released).digest("hex")).toBe(
      "17717f32298f76b4879e83155f19e94e94e8018413129592335513945051cca3",
    );
  });
});
