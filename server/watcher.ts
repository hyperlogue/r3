// Watch only the files that open reviews actually point at, and push
// `file-changed` over SSE so the UI stays fresh and the server re-anchors on the
// next detail fetch. Watching whole repos recursively blows
// the fd limit, and most diff reviews pin immutable shas anyway — so we track a
// small, dynamic set: each open `files` review's source files plus every
// feedback's anchored file. The v2 daemon is multi-repo, so each review's files
// are resolved against *its* worktree — fd cost stays
// bounded across repos because the set is still only what open reviews reference.

import { type FSWatcher, watch } from "node:fs";
import * as db from "./db.ts";
import { markDirty } from "./dirty.ts";
import { type Repo, resolveRepoForReview } from "./repo.ts";
import { hasScratchDir, isScratchReview, scratchReviewDir, scratchSafePath } from "./scratch.ts";
import { broadcast } from "./sse.ts";

// What to watch at an absolute path: a single file (`rel` = its repo/scratch-
// relative form), or a scratch review's directory (`dir:true`, `rel` = the review
// id used to prefix the changed filename). `reviews` is the set of open reviews
// referencing this path — marked dirty on a change so they re-anchor (dirty.ts).
// A dir watch is never self-closed and catches add/remove/modify of its direct
// children (non-recursive, so it works identically on macOS FSEvents + Linux).
interface Target {
  rel: string;
  dir?: boolean;
  reviews: Set<string>;
}

// Absolute paths to watch (keyed by abs since the same repo-relative path can
// occur in two different repos). Repo resolution is memoized per refresh by
// (repo, worktree) and runs with touch:false — this is a background timer, so it
// must not spawn one `git worktree list` per review nor churn last_seen each tick.
async function desiredPaths(): Promise<Map<string, Target>> {
  const want = new Map<string, Target>();
  const add = (abs: string, rel: string, reviewId: string, dir = false) => {
    const t = want.get(abs);
    if (t) t.reviews.add(reviewId);
    else want.set(abs, { rel, dir, reviews: new Set([reviewId]) });
  };
  const repoCache = new Map<string, Repo | null>(); // repo_id+worktree -> Repo
  for (const review of db.listReviews({ status: "open" })) {
    if (isScratchReview(review)) {
      // A `--scratch` review: watch its directory — any add/remove/modify of a
      // file in it refreshes the review's file list + content. A legacy single-
      // file scratch doc (no dir) falls back to watching its stored/anchored files.
      if (hasScratchDir(review.id)) {
        add(scratchReviewDir(review.id), review.id, review.id, true);
      } else {
        const rels = new Set<string>(review.source.files);
        for (const fb of db.listFeedback(review.id)) if (fb.file) rels.add(fb.file);
        for (const rel of rels) {
          const abs = scratchSafePath(rel);
          if (abs) add(abs, rel, review.id);
        }
      }
      continue;
    }
    // Diff reviews render from stored, immutable rounds — nothing on
    // disk to watch, and their anchors can never drift.
    if (!("ref" in review.source)) continue;
    const key = `${review.repo_id}\0${review.worktree?.name ?? ""}`;
    let repo = repoCache.get(key);
    if (repo === undefined) {
      repo = await resolveRepoForReview(review, { touch: false });
      repoCache.set(key, repo);
    }
    if (!repo || repo.stale) continue;
    const rels = new Set<string>(review.source.files);
    for (const fb of db.listFeedback(review.id)) if (fb.file) rels.add(fb.file);
    for (const rel of rels) {
      const abs = repo.safePath(rel);
      if (abs) add(abs, rel, review.id);
    }
  }
  return want;
}

export function startWatcher(): () => void {
  const watched = new Map<string, FSWatcher>();
  let pending = new Set<string>();
  // The reviews whose watched files changed this debounce window — carried on the
  // broadcast so the SSE review-filter (index.ts) can drop a `file-changed` for
  // `r3 watch <other>` clients instead of waking every watcher on any change.
  let pendingReviews = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;

  const flush = () => {
    timer = null;
    const paths = [...pending];
    const reviewIds = [...pendingReviews];
    pending = new Set();
    pendingReviews = new Set();
    if (paths.length) broadcast({ type: "file-changed", paths, reviewIds });
  };
  const onChange = (rel: string, reviewIds: Iterable<string>) => {
    pending.add(rel);
    for (const rid of reviewIds) pendingReviews.add(rid);
    if (!timer) timer = setTimeout(flush, 150);
  };

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const want = await desiredPaths();
      for (const [abs, w] of watched) {
        if (!want.has(abs)) {
          w.close();
          watched.delete(abs);
        }
      }
      for (const [abs, target] of want) {
        if (watched.has(abs)) continue;
        try {
          const w = watch(abs, { recursive: false }, (eventType, filename) => {
            // Content changed → the referencing reviews need to re-anchor on their
            // next detail fetch (dirty.ts); until then, incidental fetches skip it.
            for (const rid of target.reviews) markDirty(rid);
            if (target.dir) {
              // A file in the scratch dir was added/removed/modified — funnel it
              // through the same file-changed broadcast (the web refetches the
              // detail = new file list, and the blobs = content). The directory
              // persists, so never self-close.
              onChange(filename ? `${target.rel}/${filename}` : target.rel, target.reviews);
              return;
            }
            onChange(target.rel, target.reviews);
            // Editors that save via write-temp-then-rename replace the inode, so
            // a file watch goes stale after the first event. Drop it; the next
            // refresh re-watches the new file.
            if (eventType === "rename") {
              w.close();
              watched.delete(abs);
            }
          });
          watched.set(abs, w);
        } catch {
          // file/dir may not exist on disk (e.g. STAGED-only content) — skip
        }
      }
    } catch (err) {
      // desiredPaths()/db can throw (a repo vanished mid-resolve, a git call
      // failed, sqlite hiccup). Without a catch this rejects the timer callback
      // as an unhandled rejection every 4s tick; log and continue — the next
      // tick retries against fresh state. `finally` still clears `refreshing`.
      console.error("r3 watcher refresh failed:", err);
    } finally {
      refreshing = false;
    }
  };

  void refresh();
  const interval = setInterval(() => void refresh(), 4000);

  return () => {
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    for (const w of watched.values()) w.close();
  };
}
