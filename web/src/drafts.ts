// Client-only feedback drafts: the in-progress composers on a review that are NOT
// saved on the server until the human posts them. One record per review holds all
// three compose surfaces — the anchored new-feedback composer (a line/quote anchor
// + its note), the general (review-level) note, and a per-feedback map of
// in-progress replies — so a half-written note of any kind survives a review-switch
// (the view remounts per id) and a page reload, and surfaces as a badge/guard so it
// can't be silently forgotten (none of it has reached the agent). A tiny reactive
// external store (like project.ts) so the reviews-list badge, the panel header, and
// each reply composer — different subtrees — stay in sync.

import { useSyncExternalStore } from "react";
import type { PendingAnchor } from "./selection.ts";

export interface Draft {
  anchor: PendingAnchor | null; // the anchored composer's line/quote target
  text: string; // the anchored composer's note
  general: string; // the review-level general note
  replies: Record<string, string>; // feedbackId -> in-progress reply
  updatedAt: number;
}

const PREFIX = "r3-draft-";
const lsKey = (reviewId: string) => `${PREFIX}${reviewId}`;

// "Content" = any typed text across the three surfaces. A bare anchor with no text
// anywhere is a transient just-selected composer (it shows) but doesn't count for
// the badge/guard or persistence.
function contentCount(d: Draft | null | undefined): number {
  if (!d) return 0;
  let n = 0;
  if (d.text.trim() !== "") n++;
  if (d.general.trim() !== "") n++;
  for (const t of Object.values(d.replies)) if (t.trim() !== "") n++;
  return n;
}
const hasContent = (d: Draft | null | undefined): d is Draft => contentCount(d) > 0;
// Nothing worth keeping in memory at all: no anchor, and every input *literally*
// empty. A whitespace-only note isn't "content" (contentCount trims, so it doesn't
// badge or persist), but it must stay in the in-memory cache so its controlled
// composer input can actually hold the space the user just typed — dropping it here
// would reset the textarea to "" and swallow the keystroke.
const isBlank = (d: Draft): boolean =>
  d.anchor == null && d.text === "" && d.general === "" && Object.keys(d.replies).length === 0;

// Coerce any stored/spread shape into a full Draft, dropping empty reply entries so
// the map only ever holds live drafts. Tolerates legacy records that predate the
// general/replies fields.
function normalize(d: Partial<Draft> | null | undefined): Draft {
  const replies: Record<string, string> = {};
  if (d?.replies) {
    for (const [k, v] of Object.entries(d.replies))
      if (typeof v === "string" && v.trim() !== "") replies[k] = v;
  }
  return {
    anchor: d?.anchor ?? null,
    text: typeof d?.text === "string" ? d.text : "",
    general: typeof d?.general === "string" ? d.general : "",
    replies,
    updatedAt: d?.updatedAt ?? 0,
  };
}

// Live state: the current draft per review, hydrated once from localStorage.
// Whether a review has badge-worthy content is derived on read (hasContent),
// never tracked as a parallel set that could drift out of sync with the cache.
const cache = new Map<string, Draft>();
const listeners = new Set<() => void>();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const emit = () => {
  for (const l of listeners) l();
};

try {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const id = k.slice(PREFIX.length);
    try {
      const d = normalize(JSON.parse(localStorage.getItem(k) ?? "null"));
      if (hasContent(d)) {
        cache.set(id, d);
      } else {
        localStorage.removeItem(k); // drop a persisted empty (shouldn't happen)
      }
    } catch {
      localStorage.removeItem(k);
    }
  }
} catch {
  // localStorage unavailable (private mode / quota) — degrade to in-memory.
}

// Persist drafts with content only; a content-less record (a bare anchor) lives in
// memory (so its composer shows) but never hits localStorage, and clears the badge.
// A fully blank record is dropped entirely.
function commit(reviewId: string, draft: Draft | null): void {
  const norm = draft ? normalize(draft) : null;
  if (!norm || isBlank(norm)) cache.delete(reviewId);
  else cache.set(reviewId, norm);
  // Persist only a content-bearing draft; a bare anchor lives in memory only (so its
  // composer shows) and a blank record not at all — either way the stored key clears.
  try {
    if (norm && hasContent(norm)) localStorage.setItem(lsKey(reviewId), JSON.stringify(norm));
    else localStorage.removeItem(lsKey(reviewId));
  } catch {}
  emit();
}

// The current record to modify, or an empty one to build on.
function current(reviewId: string): Draft {
  return cache.get(reviewId) ?? { anchor: null, text: "", general: "", replies: {}, updatedAt: 0 };
}

export function getDraft(reviewId: string): Draft | null {
  return cache.get(reviewId) ?? null;
}

// Set/replace the anchor (a new selection), keeping any text already typed — one
// anchored draft per review, so re-selecting just re-points the same note.
export function setDraftAnchor(reviewId: string, anchor: PendingAnchor): void {
  commit(reviewId, { ...current(reviewId), anchor, updatedAt: Date.now() });
}

// The anchored composer's note.
export function setDraftText(reviewId: string, text: string): void {
  commit(reviewId, { ...current(reviewId), text, updatedAt: Date.now() });
}

// The review-level general note.
export function setGeneralText(reviewId: string, general: string): void {
  commit(reviewId, { ...current(reviewId), general, updatedAt: Date.now() });
}

// A per-feedback in-progress reply. Empty text drops the entry (nothing to keep).
export function setReplyText(reviewId: string, feedbackId: string, text: string): void {
  const c = current(reviewId);
  const replies = { ...c.replies };
  if (text.trim() === "") delete replies[feedbackId];
  else replies[feedbackId] = text;
  commit(reviewId, { ...c, replies, updatedAt: Date.now() });
}

// Discard just the anchored composer (its anchor + note); keep general + replies.
export function dropAnchor(reviewId: string): void {
  const c = cache.get(reviewId);
  if (!c) return;
  commit(reviewId, { ...c, anchor: null, text: "", updatedAt: Date.now() });
}

// Discard just the general note; keep the anchored composer + replies.
export function clearGeneral(reviewId: string): void {
  const c = cache.get(reviewId);
  if (!c) return;
  commit(reviewId, { ...c, general: "", updatedAt: Date.now() });
}

// Nuke the whole record (the review was deleted/forgotten).
export function clearDraft(reviewId: string): void {
  commit(reviewId, null);
}

// Drop reply drafts whose feedback no longer exists on the review (deleted here or
// by another client). Without this an orphaned draft would linger forever in the
// pill/guard count with no card left to surface or clear it. A no-op unless
// something is actually pruned, so it's safe to call on every review render.
export function pruneReplyDrafts(reviewId: string, keepFeedbackIds: Iterable<string>): void {
  const c = cache.get(reviewId);
  if (!c) return;
  const keep = keepFeedbackIds instanceof Set ? keepFeedbackIds : new Set(keepFeedbackIds);
  const kept = Object.entries(c.replies).filter(([id]) => keep.has(id));
  if (kept.length === Object.keys(c.replies).length) return; // nothing orphaned
  commit(reviewId, { ...c, replies: Object.fromEntries(kept), updatedAt: Date.now() });
}

// Reactive views. Each returns a narrow slice so a change to one surface only
// re-renders the subtree that reads it: typing a reply re-renders that one card,
// not the whole panel or ReviewView. The anchor ref is carried across text edits
// (the setters spread it), so useDraftAnchor stays stable while a note is typed.
export function useDraftAnchor(reviewId: string): PendingAnchor | null {
  return useSyncExternalStore(subscribe, () => cache.get(reviewId)?.anchor ?? null);
}
export function useDraftText(reviewId: string): string {
  return useSyncExternalStore(subscribe, () => cache.get(reviewId)?.text ?? "");
}
// Whether the anchored composer already holds text — a boolean slice (unlike
// useDraftText) so a subscriber that only cares about the empty/non-empty flip
// (ReviewView, for the touch pill's "Add feedback" vs "Quote in note" label)
// doesn't re-render on every keystroke.
export function useHasAnchoredText(reviewId: string): boolean {
  return useSyncExternalStore(subscribe, () => (cache.get(reviewId)?.text ?? "").trim() !== "");
}
export function useGeneralDraft(reviewId: string): string {
  return useSyncExternalStore(subscribe, () => cache.get(reviewId)?.general ?? "");
}
export function useReplyDraft(reviewId: string, feedbackId: string): string {
  return useSyncExternalStore(subscribe, () => cache.get(reviewId)?.replies[feedbackId] ?? "");
}
// useHasDraft drives the reviews-list badge; useDraftCount drives the panel's pill
// (and its hand-off guard) with a count of the distinct unsaved surfaces.
export function useHasDraft(reviewId: string): boolean {
  return useSyncExternalStore(subscribe, () => hasContent(cache.get(reviewId)));
}
export function useDraftCount(reviewId: string): number {
  return useSyncExternalStore(subscribe, () => contentCount(cache.get(reviewId)));
}

// Cross-tab: another tab editing/clearing a draft updates our badges + composers.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    const id = e.key.slice(PREFIX.length);
    try {
      const d = e.newValue ? normalize(JSON.parse(e.newValue)) : null;
      if (d && hasContent(d)) cache.set(id, d);
      else cache.delete(id);
    } catch {}
    emit();
  });
}
