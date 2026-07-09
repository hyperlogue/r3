// Referencing a code location from inside a feedback/reply composer. When the
// human picks a line range in the gutter (the deliberate "these lines" gesture)
// *while a composer already holds text*, that range is spliced into the composer
// as an `@path:Lx-y` mention instead of starting a fresh anchored draft — so one
// note can point at several places, not just its own anchor.
//
// The line-range (gutter) gesture is the trigger on purpose: a loose text
// selection stays a plain text selection (the human may just be selecting to
// copy), so only ReviewView's onPickLines routes through here — the
// getSelectionAnchor path is untouched.
//
// Mechanism: a tiny imperative registry (no React state). Each composer registers
// itself as the active target while focused and relinquishes on blur/unmount; the
// gutter's mousedown preventDefault keeps that focus through the pick, so the
// composer the cursor is in stays the target. onPickLines consults
// getMentionTarget() and, when it's non-empty, hands the pick here.

import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { PendingAnchor } from "./selection.ts";
import { SUMMARY_FILE } from "./types.ts";

export interface MentionTarget {
  // The composer holds text right now — only then does a pick become a mention;
  // an empty composer yields to the normal anchored-draft path.
  isNonEmpty: () => boolean;
  // Splice the mention into the composer at the caret, then refocus it.
  insert: (mention: string) => void;
}

let active: MentionTarget | null = null;

function setMentionTarget(t: MentionTarget): void {
  active = t;
}
// Only relinquish if we're still the active one — a newer focus may already have
// replaced us (blur of the old target can fire after focus of the new).
function clearMentionTarget(t: MentionTarget): void {
  if (active === t) active = null;
}
export function getMentionTarget(): MentionTarget | null {
  return active;
}

// The `@path:Lx[-y]` token for a picked line range. Summary anchors have no file
// path to point at, so they never become a mention (returns null → caller falls
// back to the normal anchored-draft path).
export function formatMention(a: PendingAnchor): string | null {
  if (a.file === SUMMARY_FILE) return null;
  const range = a.lineEnd !== a.lineStart ? `L${a.lineStart}-${a.lineEnd}` : `L${a.lineStart}`;
  return `@${a.file}:${range}`;
}

// Splice `mention` into `text` over the [start,end) selection (usually a collapsed
// caret), padding with a single space on each side when the neighbour isn't
// already whitespace — so it reads as its own token. Returns the new text and the
// caret offset just past the inserted mention.
export function spliceMention(
  text: string,
  start: number,
  end: number,
  mention: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " "; // also adds one when `after` is empty
  const chunk = `${lead}${mention}${trail}`;
  return { text: before + chunk + after, caret: before.length + chunk.length };
}

// Register a controlled textarea as the mention target while it's focused. Spread
// the returned handlers onto the textarea. The target reads live value/onChange
// through refs, so the single registered object never goes stale as the composer
// re-renders.
export function useMentionTarget(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (next: string) => void,
): { onFocus: () => void; onBlur: () => void } {
  const valueRef = useRef(value);
  const changeRef = useRef(onChange);
  valueRef.current = value;
  changeRef.current = onChange;

  const targetRef = useRef<MentionTarget | null>(null);
  if (!targetRef.current) {
    targetRef.current = {
      isNonEmpty: () => valueRef.current.trim() !== "",
      insert: (mention) => {
        const el = ref.current;
        const cur = valueRef.current;
        const start = el?.selectionStart ?? cur.length;
        const end = el?.selectionEnd ?? start;
        const next = spliceMention(cur, start, end, mention);
        changeRef.current(next.text);
        // Restore focus + caret once React has committed the new value (rAF runs
        // after the state flush our onChange scheduled).
        requestAnimationFrame(() => {
          const e2 = ref.current;
          if (!e2) return;
          e2.focus();
          e2.setSelectionRange(next.caret, next.caret);
        });
      },
    };
  }

  const onFocus = useCallback(() => {
    if (targetRef.current) setMentionTarget(targetRef.current);
  }, []);
  const onBlur = useCallback(() => {
    if (targetRef.current) clearMentionTarget(targetRef.current);
  }, []);
  // Relinquish on unmount too, so a closed composer never lingers as the target.
  useEffect(() => {
    return () => {
      if (targetRef.current) clearMentionTarget(targetRef.current);
    };
  }, []);
  return { onFocus, onBlur };
}
