// The version rules: which round resolves, how a selection is clamped back into a
// set that shrank under it, and where one `<`/`>` step lands. Worth a test on the
// repo's usual terms — states plus an ordering, cheap to state and invisible to
// `tsc`: every one of these failures shows up as the pane quietly rendering a
// different version than the one asked for, never as an error.

import { expect, test } from "bun:test";
import {
  clampSnapRange,
  paneVersionKeyFor,
  resolveRoundSeq,
  snapshotOrder,
  stepRoundSeq,
  stepSnapRange,
} from "./reviewVersion.ts";
import type { PatchMeta, SnapshotMeta } from "./types.ts";

const rounds = (...seqs: number[]): PatchMeta[] =>
  seqs.map((seq) => ({ seq, label: null, summary: null, created_at: "" }));

const snaps = (...seqs: number[]): SnapshotMeta[] =>
  seqs.map((seq) => ({ seq, label: null, created_at: "", files: [] }));

// ---- resolveRoundSeq --------------------------------------------------------

test("an unpicked round resolves to the latest", () => {
  expect(resolveRoundSeq(null, rounds(1, 2, 3), true)).toBe(3);
});

test("a picked round wins while it still names a stored round", () => {
  expect(resolveRoundSeq(2, rounds(1, 2, 3), true)).toBe(2);
});

test("a picked round that was removed falls back to the latest", () => {
  expect(resolveRoundSeq(9, rounds(1, 2), true)).toBe(2);
});

test("a diff review with no stored rounds is the legacy live-render round 0", () => {
  expect(resolveRoundSeq(null, [], true)).toBe(0);
});

test("a files review has no round at all", () => {
  expect(resolveRoundSeq(null, [], false)).toBeNull();
});

// ---- clampSnapRange ---------------------------------------------------------

test("a range already inside the set needs no correction", () => {
  expect(clampSnapRange({ from: 1, to: 2 }, snaps(1, 2))).toBeNull();
  expect(clampSnapRange({ from: null, to: "WORKING" }, [])).toBeNull();
});

test("a `from` whose snapshot was removed drops to None, keeping `to`", () => {
  expect(clampSnapRange({ from: 1, to: 3 }, snaps(2, 3))).toEqual({ from: null, to: 3 });
});

test("a `to` whose snapshot was removed falls back to live", () => {
  expect(clampSnapRange({ from: 2, to: 9 }, snaps(2, 3))).toEqual({ from: 2, to: "WORKING" });
});

test("switching to a review with no snapshots resets both bounds", () => {
  expect(clampSnapRange({ from: 1, to: 2 }, [])).toEqual({ from: null, to: "WORKING" });
});

// ---- snapshotOrder ----------------------------------------------------------

test("the step order is oldest snapshot -> newest -> Current, however they arrive", () => {
  expect(snapshotOrder(snaps(3, 1, 2))).toEqual([1, 2, 3, "WORKING"]);
});

// ---- stepRoundSeq -----------------------------------------------------------

test("stepping rounds moves one at a time and clamps without wrapping", () => {
  const rs = rounds(1, 2, 3);
  expect(stepRoundSeq(rs, 1, 1)).toBe(2);
  expect(stepRoundSeq(rs, 3, 1)).toBe(3); // past the newest: stop, don't restart
  expect(stepRoundSeq(rs, 1, -1)).toBe(1); // past the oldest: likewise
  expect(stepRoundSeq([], null, 1)).toBeNull();
});

// ---- stepSnapRange ----------------------------------------------------------

test("stepping `to` walks the order and stops at Current", () => {
  const ss = snaps(1, 2);
  expect(stepSnapRange(ss, { from: null, to: 1 }, 1)).toEqual({ from: null, to: 2 });
  expect(stepSnapRange(ss, { from: null, to: 2 }, 1)).toEqual({ from: null, to: "WORKING" });
  expect(stepSnapRange(ss, { from: null, to: "WORKING" }, 1)).toBeNull();
});

test("`from` is left alone while it stays below `to`", () => {
  expect(stepSnapRange(snaps(1, 2, 3), { from: 1, to: 2 }, 1)).toEqual({ from: 1, to: 3 });
});

test("stepping `to` down onto `from` drags `from` below it rather than inverting", () => {
  expect(stepSnapRange(snaps(1, 2, 3), { from: 2, to: 3 }, -1)).toEqual({ from: 1, to: 2 });
});

test("stepping `to` to the oldest snapshot leaves no room below, so `from` becomes None", () => {
  expect(stepSnapRange(snaps(1, 2), { from: 1, to: 2 }, -1)).toEqual({ from: null, to: 1 });
});

test("a review with no snapshots has nowhere to step", () => {
  expect(stepSnapRange([], { from: null, to: "WORKING" }, -1)).toBeNull();
});

// ---- paneVersionKeyFor ------------------------------------------------------

test("the pane key is null until a review has loaded, so the first render isn't a switch", () => {
  expect(
    paneVersionKeyFor({
      ready: false,
      isDiff: true,
      roundSeq: 2,
      range: { from: null, to: "WORKING" },
    }),
  ).toBeNull();
});

test("the pane key separates every version the pane can switch between", () => {
  const key = (isDiff: boolean, roundSeq: number | null, from: number | null, to: 1 | "WORKING") =>
    paneVersionKeyFor({ ready: true, isDiff, roundSeq, range: { from, to } });
  expect(key(true, 1, null, "WORKING")).not.toBe(key(true, 2, null, "WORKING"));
  expect(key(false, null, null, "WORKING")).not.toBe(key(false, null, 1, "WORKING"));
  expect(key(false, null, null, 1)).not.toBe(key(false, null, null, "WORKING"));
});
