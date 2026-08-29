// Placing a files-review feedback into a derived diff by quote. Worth a test
// because the search is a seam with no type to guard it: the index is built once
// per diff and every note is placed against it, so an off-by-one in the row
// extraction (a side, a hunk gap, a rename's old path) silently mislands a
// highlight rather than failing anywhere visible.

import { expect, test } from "bun:test";
import { indexDiff, placeInDiff } from "./resolveFeedback.ts";
import type { DiffFileChange, DiffLine, DiffLineType } from "./types.ts";

const row = (
  type: DiffLineType,
  oldLine: number | null,
  newLine: number | null,
  text: string,
): DiffLine => ({ type, oldLine, newLine, text, html: text });

const file = (lines: DiffLine[], paths?: Partial<DiffFileChange>): DiffFileChange => ({
  oldPath: "a.ts",
  newPath: "a.ts",
  path: "a.ts",
  status: "modified",
  binary: false,
  additions: 0,
  deletions: 0,
  lines,
  ...paths,
});

const fb = (quote: string, line_start: number | null = null) => ({
  file: "a.ts",
  quote,
  line_start,
});

test("places a quote on the new side and spans its own line count", () => {
  const index = indexDiff([
    file([
      row("hunk", null, null, "@@ -1,3 +1,4 @@"),
      row("context", 1, 1, "const a = 1;"),
      row("add", null, 2, "const b = 2;"),
      row("add", null, 3, "const c = 3;"),
      row("context", 2, 4, "export { a };"),
    ]),
  ]);
  expect(placeInDiff(index, fb("const b = 2;\nconst c = 3;"))).toEqual({
    file: "a.ts",
    side: "new",
    lineStart: 2,
    lineEnd: 3,
  });
});

test("falls through to the old side for deleted text", () => {
  const index = indexDiff([
    file([
      row("context", 1, 1, "keep"),
      row("del", 2, null, "gone forever"),
      row("add", null, 2, "replacement"),
    ]),
  ]);
  expect(placeInDiff(index, fb("gone forever"))).toEqual({
    file: "a.ts",
    side: "old",
    lineStart: 2,
    lineEnd: 2,
  });
});

test("the line hint picks between repeated lines, whitespace aside", () => {
  const index = indexDiff([
    file([
      row("context", 1, 1, "  });"),
      row("context", 2, 2, "filler"),
      row("context", 3, 3, "});"),
    ]),
  ]);
  expect(placeInDiff(index, fb("});", 3))?.lineStart).toBe(3);
  expect(placeInDiff(index, fb("});", 1))?.lineStart).toBe(1);
});

test("a multi-line quote stops at a hunk gap instead of smearing across it", () => {
  const index = indexDiff([
    file([
      row("context", 10, 10, "first"),
      row("hunk", null, null, "@@ -40,2 +40,2 @@"),
      row("context", 40, 40, "second"),
    ]),
  ]);
  expect(placeInDiff(index, fb("first\nsecond"))).toEqual({
    file: "a.ts",
    side: "new",
    lineStart: 10,
    lineEnd: 10,
  });
});

test("a renamed file answers to the path the feedback holds", () => {
  const index = indexDiff([
    file([row("context", 1, 1, "moved")], {
      oldPath: "old.ts",
      newPath: "new.ts",
      path: "new.ts",
      status: "renamed",
    }),
  ]);
  expect(placeInDiff(index, { file: "old.ts", quote: "moved", line_start: null })?.side).toBe(
    "new",
  );
  expect(placeInDiff(index, { file: "new.ts", quote: "moved", line_start: null })?.side).toBe(
    "new",
  );
  expect(placeInDiff(index, { file: "gone.ts", quote: "moved", line_start: null })).toBeNull();
});

test("an unfound quote is unplaced, not guessed at", () => {
  const index = indexDiff([file([row("context", 1, 1, "something else")])]);
  expect(placeInDiff(index, fb("not in this diff"))).toBeNull();
  expect(placeInDiff(index, fb("   "))).toBeNull();
});
