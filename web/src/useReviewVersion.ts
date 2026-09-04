// The version state behind the content pane: which diff round, or which snapshot
// from -> to range, is on screen. One seam, because everything downstream — the
// pane's crossfade key, the file list, the viewed keys, the expand-context
// fetchers, the `<`/`>` keys, the round a whole-file note opens against — is a
// function of exactly these three pieces of state. The rules it applies are pure
// and live in reviewVersion.ts.

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  clampSnapRange,
  paneVersionKeyFor,
  resolveRoundSeq,
  SNAPSHOT_DIFF_SEQ,
  stepRoundSeq,
  stepSnapRange,
} from "./reviewVersion.ts";
import type { PatchMeta, ReviewKind, SnapshotMeta, SnapshotRef } from "./types.ts";

export interface ReviewVersion {
  // --- the three pieces of state, and their setters (the pickers write them) ---
  activeRoundSeq: number | null;
  setActiveRoundSeq: Dispatch<SetStateAction<number | null>>;
  fromSnap: number | null;
  setFromSnap: Dispatch<SetStateAction<number | null>>;
  toSnap: SnapshotRef;
  setToSnap: Dispatch<SetStateAction<SnapshotRef>>;
  // --- what the rest of the view reads ---
  rounds: readonly PatchMeta[];
  snapshots: readonly SnapshotMeta[];
  isDiff: boolean;
  /** The round on screen (see resolveRoundSeq). */
  effectiveRoundSeq: number | null;
  /** A files review with a `from` picked: the pane renders a derived diff. */
  diffMode: boolean;
  /** The live files view — the only mode that tracks viewed state by sha. */
  liveFilesView: boolean;
  paneVersionKey: string | null;
  /** Whether `<`/`>` have anywhere to go (the same test the toolbar uses). */
  canStep: boolean;
  step: (dir: 1 | -1) => void;
  /** The round a whole-file note opens against, per mode. */
  feedbackPatchSeq: number | undefined;
}

export function useReviewVersion(input: {
  /** The review's kind, or undefined before it loads. */
  kind: ReviewKind | undefined;
  rounds: readonly PatchMeta[];
  snapshots: readonly SnapshotMeta[];
}): ReviewVersion {
  const { kind, rounds, snapshots } = input;
  // Which diff round the tab strip has selected — null until the human picks one,
  // then `effectiveRoundSeq` resolves it. Only one round renders at a time, so it
  // also scopes the file browser + scroll-spy.
  const [activeRoundSeq, setActiveRoundSeq] = useState<number | null>(null);
  const [fromSnap, setFromSnap] = useState<number | null>(null);
  const [toSnap, setToSnap] = useState<SnapshotRef>("WORKING");

  const isDiff = kind === "diff";
  const effectiveRoundSeq = resolveRoundSeq(activeRoundSeq, rounds, isDiff);

  // Keep the from/to selection inside the snapshot set it names.
  const snapKey = snapshots.map((s) => s.seq).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapKey encodes the snapshot set the selection must stay within
  useEffect(() => {
    const fixed = clampSnapRange({ from: fromSnap, to: toSnap }, snapshots);
    if (!fixed) return;
    setFromSnap(fixed.from);
    setToSnap(fixed.to);
  }, [snapKey]);

  const diffMode = kind === "files" && fromSnap != null;
  const liveFilesView = !isDiff && !diffMode && toSnap === "WORKING";
  const paneVersionKey = paneVersionKeyFor({
    ready: kind !== undefined,
    isDiff,
    roundSeq: effectiveRoundSeq,
    range: { from: fromSnap, to: toSnap },
  });

  const step = useCallback(
    (dir: 1 | -1) => {
      if (isDiff) {
        const next = stepRoundSeq(rounds, effectiveRoundSeq, dir);
        if (next != null) setActiveRoundSeq(next);
        return;
      }
      const next = stepSnapRange(snapshots, { from: fromSnap, to: toSnap }, dir);
      if (!next) return;
      setFromSnap(next.from);
      setToSnap(next.to);
    },
    [isDiff, rounds, effectiveRoundSeq, snapshots, fromSnap, toSnap],
  );

  return useMemo(
    () => ({
      activeRoundSeq,
      setActiveRoundSeq,
      fromSnap,
      setFromSnap,
      toSnap,
      setToSnap,
      rounds,
      snapshots,
      isDiff,
      effectiveRoundSeq,
      diffMode,
      liveFilesView,
      paneVersionKey,
      canStep: isDiff ? rounds.length > 1 : snapshots.length > 0,
      step,
      feedbackPatchSeq: isDiff
        ? (effectiveRoundSeq ?? undefined)
        : diffMode
          ? SNAPSHOT_DIFF_SEQ
          : undefined,
    }),
    [
      activeRoundSeq,
      fromSnap,
      toSnap,
      rounds,
      snapshots,
      isDiff,
      effectiveRoundSeq,
      diffMode,
      liveFilesView,
      paneVersionKey,
      step,
    ],
  );
}
