// Live updates: one shared EventSource to /api/events; React Query invalidations
// on the server's SSE events keep the UI fresh without polling.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ServerEvent } from "./types.ts";

export function useServerEvents(reviewId?: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const invalidate = (queryKey: readonly unknown[]) => qc.invalidateQueries({ queryKey });
    const url = reviewId ? `/api/events?review=${reviewId}` : "/api/events";
    const es = new EventSource(url);
    // EventSource fires `open` on the first connect and again on every auto-reconnect.
    // A backgrounded tab can have its stream suspended or dropped by the browser (so
    // live events are missed and the UI only catches up on the next tab focus). When
    // the stream comes back, re-sync everything it feeds so a reconnect refreshes the
    // view in place — no tab switch required. Skip the initial connect (nothing missed
    // yet; the queries just mounted fresh).
    let connected = false;
    es.onopen = () => {
      if (!connected) {
        connected = true;
        return;
      }
      for (const key of [
        "review",
        "review-diff",
        "reviews",
        "repos",
        "watchers",
        "blob",
        "snapshot-diff",
      ]) {
        invalidate([key]);
      }
    };
    const onAny = (raw: MessageEvent) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (ev.type === "review-updated" || ev.type === "feedback-updated") {
        invalidate(["review", ev.reviewId]);
        // A `diff add`/`diff rm` fires review-updated — refetch the rounds too.
        invalidate(["review-diff", ev.reviewId]);
        invalidate(["reviews"]);
      } else if (ev.type === "watchers-changed") {
        invalidate(["watchers", ev.reviewId]);
        // The list carries a live `watching` flag and ranks watched reviews to
        // the top — refetch so the ordering tracks who's watching.
        invalidate(["reviews"]);
      } else if (ev.type === "reviews-changed") {
        invalidate(["reviews"]);
        invalidate(["repos"]);
        // A delete/create elsewhere fires only reviews-changed — refetch any open
        // detail too, so a review deleted out from under an open tab 404s (which
        // ReviewView surfaces) instead of showing forever-stale cached content.
        invalidate(["review"]);
      } else if (ev.type === "file-changed") {
        // Content moved under the review → refetch detail (re-anchors) + blobs.
        invalidate(["review"]);
        invalidate(["blob"]);
        // A files review's snapshot→live diff (to=Current) is derived from the live
        // content, so a live edit must refresh it too. Snapshot→snapshot
        // diffs are immutable, so an unchanged-input refetch just revalidates.
        invalidate(["snapshot-diff"]);
      }
    };
    const types = [
      "review-updated",
      "feedback-updated",
      "file-changed",
      "reviews-changed",
      "watchers-changed",
    ];
    for (const t of types) {
      es.addEventListener(t, onAny);
    }
    return () => es.close();
  }, [qc, reviewId]);
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("r3-theme", next ? "dark" : "light");
  };
  return [dark, toggle];
}
