// Which version of the review the content pane shows, as pure rules — no React,
// no stores, so each can be stated and tested on its own (the resolveFeedback.ts
// shape). useReviewVersion.ts wires these to state.
//
// A diff review's versions are its stored rounds; a files review's are its
// content snapshots, picked as a from -> to range (from = null is "no diff", a
// plain view of `to`). These are the rules worth pinning: clamping a selection
// back into a set that shrank under it, and a no-wrap step that has to drag
// `from` down when `to` crosses it. Neither fails loudly when it is wrong — the
// pane just shows a different version than the one asked for.

import type { PatchMeta, SnapshotMeta, SnapshotRef } from "./types.ts";

// Synthetic [data-round] seq for a files-review snapshot-diff, which DiffView
// renders as one round so it gets the same gutter-drag/fold/side-aware rows.
// Never sent to the server (files-review feedback has patch_seq null).
export const SNAPSHOT_DIFF_SEQ = 0;

// A files review's picked range: `from` null = None (no diff — a plain view of
// `to`); `to` "WORKING" = the live content (the default).
export interface SnapRange {
  from: number | null;
  to: SnapshotRef;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// The round on screen: the human's pick while it still names a stored round, else
// the latest. A diff review with no stored rounds falls back to seq 0 — the
// legacy live-render round — where a files review has no round at all.
export function resolveRoundSeq(
  picked: number | null,
  rounds: readonly PatchMeta[],
  isDiff: boolean,
): number | null {
  if (picked != null && rounds.some((r) => r.seq === picked)) return picked;
  return rounds[rounds.length - 1]?.seq ?? (isDiff ? 0 : null);
}

// A selection that no longer resolves — a snapshot removed, or the review
// switched under a persisted component — falls back to None/live. Returns null
// when the range already fits, so the caller can skip a no-op state write.
export function clampSnapRange(
  range: SnapRange,
  snapshots: readonly SnapshotMeta[],
): SnapRange | null {
  const has = (seq: number | SnapshotRef) => snapshots.some((s) => s.seq === seq);
  const from = range.from != null && !has(range.from) ? null : range.from;
  const to: SnapshotRef = range.to !== "WORKING" && !has(range.to) ? "WORKING" : range.to;
  return from === range.from && to === range.to ? null : { from, to };
}

// The order `<`/`>` walk a files review: oldest snapshot -> newest -> Current,
// which is top-to-bottom as SnapshotSelect draws the dropdown.
export function snapshotOrder(snapshots: readonly SnapshotMeta[]): SnapshotRef[] {
  return [...[...snapshots].sort((a, b) => a.seq - b.seq).map((s) => s.seq), "WORKING"];
}

// One `<`/`>` step over a diff review's rounds. Clamped at both ends — no wrap:
// stepping past the newest round should stop, not restart at the oldest. Returns
// null when there is nowhere to go.
export function stepRoundSeq(
  rounds: readonly PatchMeta[],
  current: number | null,
  dir: 1 | -1,
): number | null {
  if (rounds.length === 0) return null;
  const at = rounds.findIndex((r) => r.seq === current);
  return rounds[clamp((at < 0 ? 0 : at) + dir, 0, rounds.length - 1)]?.seq ?? null;
}

// One `<`/`>` step over a files review's from->to range: the `to` bound moves,
// clamped at both ends. Stepping `to` down past `from` would invert the range, so
// `from` snaps below it — exactly as picking that row in the dropdown would.
// Returns null when the step would land where it already is.
export function stepSnapRange(
  snapshots: readonly SnapshotMeta[],
  range: SnapRange,
  dir: 1 | -1,
): SnapRange | null {
  if (snapshots.length === 0) return null;
  const order = snapshotOrder(snapshots);
  const at = order.indexOf(range.to);
  // A `to` that isn't in the order at all (already clamped away in practice)
  // reads as Current, so the first step from it is a real move.
  const pos = clamp((at < 0 ? order.length - 1 : at) + dir, 0, order.length - 1);
  if (pos === at) return null;
  const to = order[pos];
  const fromPos = range.from == null ? -1 : order.indexOf(range.from);
  if (fromPos < pos) return { from: range.from, to };
  const below = order[pos - 1];
  return { from: pos - 1 >= 0 && below !== "WORKING" ? (below as number) : null, to };
}

// The version the pane renders, as one string: the crossfade's key, and (with the
// review + theme folded in) the progressive bodies' reset signal. Null until there
// is a review, so the initial load doesn't read as a switch.
export function paneVersionKeyFor(input: {
  ready: boolean;
  isDiff: boolean;
  roundSeq: number | null;
  range: SnapRange;
}): string | null {
  if (!input.ready) return null;
  return input.isDiff ? `d:${input.roundSeq}` : `s:${input.range.from ?? "none"}:${input.range.to}`;
}
