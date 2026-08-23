// SSE + query invalidation.

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
        invalidate(["reviews"]);
        // Only review-updated can change a diff review's stored rounds (`diff
        // add`/`diff rm` broadcast it); a feedback write fires feedback-updated
        // alone and never touches the patches table — skip the rounds refetch on
        // the hottest path (resolve/reply/edit). The onopen re-sync above still
        // blanket-invalidates ["review-diff"] after a reconnect.
        if (ev.type === "review-updated") invalidate(["review-diff", ev.reviewId]);
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
        // Only the blobs whose file actually changed. `paths` carry the same
        // shape the blob key holds (repo-relative, or `<review id>/<name>` for a
        // scratch review), so a plain set membership test is exact. Without it
        // one agent write refetches every mounted file in the review — a
        // 40-file scratch review re-renders all 40 on each save, and an agent
        // writing them in a loop squares that. An empty list can't be narrowed.
        const changed = new Set(ev.paths);
        if (changed.size === 0) invalidate(["blob"]);
        else
          qc.invalidateQueries({
            predicate: (q) => q.queryKey[0] === "blob" && changed.has(q.queryKey[2] as string),
          });
        // Live to=WORKING diffs must refresh; pinned snapshot pairs do not.
        qc.invalidateQueries({
          predicate: (q) => q.queryKey[0] === "snapshot-diff" && q.queryKey[3] === "WORKING",
        });
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
