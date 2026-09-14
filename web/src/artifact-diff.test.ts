import { expect, test } from "bun:test";
import { rehunk } from "../../server/patch-hunks.ts";
import { gapContainingLine, gapsOf } from "./expand.ts";
import type { DiffLine } from "./types.ts";

test("native diff locate expands only captured context with the correct old/new displacement", () => {
  const lines: DiffLine[] = [
    { type: "hunk", oldLine: null, newLine: null, text: "@@ -20,40 +10,41 @@", html: "" },
  ];
  for (let i = 0; i < 40; i++) {
    if (i === 20) lines.push({ type: "add", oldLine: null, newLine: 30, text: "added", html: "" });
    lines.push({
      type: "context",
      oldLine: i + 20,
      newLine: i + 10 + (i >= 20 ? 1 : 0),
      text: `line ${i}`,
      html: "",
    });
  }
  const displayed = rehunk(lines, 3, { markExpandable: true });
  const gaps = gapsOf(displayed);
  expect(gaps).toHaveLength(2);
  expect(gapContainingLine(displayed, gaps, 21, "old")).toBe(gaps[0]);
  expect(gapContainingLine(displayed, gaps, 11, "new")).toBe(gaps[0]);
  expect(gapContainingLine(displayed, gaps, 58, "old")).toBe(gaps[1]);
  expect(gapContainingLine(displayed, gaps, 49, "new")).toBe(gaps[1]);
  expect(gapContainingLine(displayed, gaps, 11, "old")).toBeUndefined();
  expect(gapContainingLine(displayed, gaps, 58, "new")).toBeUndefined();
  expect(gapContainingLine(displayed, gaps, 100, "new")).toBeUndefined();
});
