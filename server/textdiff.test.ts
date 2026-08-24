import { describe, expect, test } from "bun:test";
import { diffFile, toDiffLines } from "./textdiff.ts";

function lines(n: number, prefix = ""): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function file(ls: string[]): string {
  return ls.length ? `${ls.join("\n")}\n` : "";
}

describe("diffFile", () => {
  test("identical contents are omitted", () => {
    expect(diffFile("a.ts", "x\n", "x\n")).toBeNull();
  });

  test("a pure insert vs empty", () => {
    const f = diffFile("a.ts", null, "one\ntwo\n");
    expect(f?.status).toBe("added");
    expect(f?.additions).toBe(2);
    expect(f?.deletions).toBe(0);
  });

  test("a pure delete", () => {
    const f = diffFile("a.ts", "one\ntwo\n", null);
    expect(f?.status).toBe("deleted");
    expect(f?.additions).toBe(0);
    expect(f?.deletions).toBe(2);
  });

  test("a one-line replacement", () => {
    const f = diffFile("a.ts", "keep\nold\nkeep\n", "keep\nnew\nkeep\n");
    expect(f?.deletions).toBe(1);
    expect(f?.additions).toBe(1);
  });

  test("inserts in the middle keep surrounding equals", () => {
    const f = diffFile("a.ts", "a\nc\n", "a\nb\nc\n");
    expect(f?.additions).toBe(1);
    expect(f?.deletions).toBe(0);
  });

  // The old LCS matrix bailed out to delete-all/add-all when m*n > 4e6, which
  // two ~2.1k-line files whose first AND last lines differ both hit — prefix
  // and suffix trim do nothing, and the shared body was thrown away.
  test("a shared body is not a full rewrite when the first and last lines differ", () => {
    const body = lines(2100, "line-");
    const oldC = file(["HEAD", ...body, "TAIL-A"]);
    const newC = file(["HEAD-changed", ...body, "TAIL-B"]);
    const f = diffFile("a.ts", oldC, newC);
    expect(f?.deletions).toBe(2);
    expect(f?.additions).toBe(2);
  });

  test("many distinct lines still reconstruct (the linear-space path)", () => {
    const oldLs = lines(400, "x-");
    const newLs = oldLs.map((l, i) => (i % 3 === 0 ? l : `y-${i}`));
    const f = diffFile("a.ts", file(oldLs), file(newLs), Number.MAX_SAFE_INTEGER);
    expect(f).not.toBeNull();
    const gotOld: string[] = [];
    const gotNew: string[] = [];
    for (const row of f!.lines) {
      if (row.type === "hunk") continue;
      if (row.type === "context" || row.type === "del") gotOld.push(row.text);
      if (row.type === "context" || row.type === "add") gotNew.push(row.text);
    }
    expect(gotOld).toEqual(oldLs);
    expect(gotNew).toEqual(newLs);
    // Reconstruction alone can't see a MINIMAL script: a bisect that misses its
    // overlap still round-trips, it just reports the span as delete-all/add-all.
    // Every third line is shared, so an optimal SES keeps exactly those.
    const shared = oldLs.filter((_, i) => i % 3 === 0).length;
    expect(f!.lines.filter((row) => row.type === "context").length).toBe(shared);
  });

  test("edit script covers both sides in order", () => {
    const oldLs = ["a", "b", "c", "d", "e"];
    const newLs = ["a", "x", "c", "y", "e"];
    const f = diffFile("a.ts", file(oldLs), file(newLs));
    expect(f).not.toBeNull();
    const gotOld: string[] = [];
    const gotNew: string[] = [];
    for (const row of f!.lines) {
      if (row.type === "hunk") continue;
      if (row.type === "context" || row.type === "del") gotOld.push(row.text);
      if (row.type === "context" || row.type === "add") gotNew.push(row.text);
    }
    expect(gotOld).toEqual(oldLs);
    expect(gotNew).toEqual(newLs);
  });
});

describe("toDiffLines", () => {
  test("drops a single trailing newline", () => {
    expect(toDiffLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toDiffLines("")).toEqual([]);
    expect(toDiffLines("a")).toEqual(["a"]);
  });
});
