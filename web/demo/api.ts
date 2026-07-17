// The demo's drop-in replacement for web/src/api.ts. The demo build aliases every
// `import … from ".../api.ts"` to this module (see scripts/build-demo.ts), so the
// whole SPA talks to the in-browser backend instead of a daemon — same method
// names, same shapes, same ApiError. Importing this module also installs the
// EventSource shim and the demo chrome, and it's the first thing main.tsx imports.

import type {
  AddReplyBody,
  CreateFeedbackBody,
  CreateReviewBody,
  DiffResult,
  FeedbackStatus,
  ReanchorBody,
  SnapshotRef,
  ThemeStyle,
  UpdateReplyBody,
  UpdateReviewBody,
} from "../../shared/types.ts";
import { runAgentHandoff } from "./agent.ts";
import * as backend from "./backend.ts";
import { broadcast, installEventSourceShim } from "./bus.ts";
import { ApiError } from "./errors.ts";
import { getState, persist } from "./store.ts";
import { armDemoWatchers, getWatchers, stopWatching } from "./watchers.ts";

// Install the SSE shim before anything constructs an EventSource, and seed the
// scripted agent as a live watcher on every review (so the panel opens in "Submit
// to agent" mode). Both are safe at import time (main.tsx imports this first,
// synchronously, before any query runs). The nav-bar "Live demo" badge + intro
// render via <DemoChrome> in the header (web/demo/demo-chrome.tsx), not here.
installEventSourceShim();
armDemoWatchers();

// The real app sends this as x-r3-token; in the demo it's cosmetic but must be
// non-empty so SettingsPopup treats the session as local (hides "Sign out").
export const TOKEN = "demo";

export { ApiError };

// No daemon to reach — the demo never needs to log in.
export async function loadBoot(): Promise<{ needsAuth: boolean }> {
  return { needsAuth: false };
}

const NO_STYLE: ThemeStyle = { lightBg: "", darkBg: "", lightFg: "", darkFg: "" };
const READ_ONLY =
  "Creating reviews isn't available in the read-only demo — explore the seeded ones.";

export const api = {
  // git browsing has no backend here (no git in the browser) — the demo runs on
  // seeded reviews, so these return empty shells.
  status: async () => ({ branch: "demo", ahead: 0, behind: 0, entries: [] }),
  log: async () => [],
  tree: async () => [],

  repos: async () => [getState().repo],
  relinkRepo: async () => getState().repo,
  renameRepo: async (_id: string, name: string) => {
    getState().repo.name = name;
    persist();
    return getState().repo;
  },
  forgetRepo: async () => ({ ok: true }) as const,
  diff: async (base: string, head: string): Promise<DiffResult> => ({ base, head, files: [] }),

  reviewDiff: async (id: string) => backend.reviewDiff(id),
  blob: async (path: string, ref = "WORKING", _theme?: string, review?: string) =>
    backend.blob(path, ref, review),

  snapshots: async (id: string) => backend.snapshots(id),
  snapshotDiff: async (id: string, from: number, to: SnapshotRef) =>
    backend.snapshotDiff(id, from, to),
  snapshotBlob: async (id: string, path: string, to: SnapshotRef) =>
    backend.snapshotBlob(id, path, to),

  themes: async () => getState().themes,
  themeStyle: async (theme?: string) => getState().themeStyles[theme ?? ""] ?? NO_STYLE,

  listReviews: async (filter: { session?: string; status?: string; repo?: string } = {}) =>
    backend.listReviews(filter),
  createReview: async (_body: CreateReviewBody): Promise<never> => {
    throw new ApiError(400, READ_ONLY);
  },
  review: async (id: string) => backend.buildDetail(id),
  patchReview: async (id: string, body: UpdateReviewBody) => backend.patchReview(id, body),
  deleteReview: async (id: string) => backend.deleteReview(id),
  promptPreview: async (id: string) => backend.promptPreview(id),
  // Copy-prompt path: mark delivered, return the text to copy, and let the
  // scripted agent react (it also re-arms itself as a watcher afterwards).
  prompt: async (id: string) => {
    const { text, feedbackIds } = backend.markPrompt(id);
    runAgentHandoff(id, feedbackIds);
    return text;
  },
  watchers: async (id: string) => ({ watchers: getWatchers(id) }),
  // Submit-to-agent path: this is the demo's headline loop. The watching agent
  // "wakes", fetches the prompt (marks it delivered), leaves `watch` to work
  // (dot clears), then replies + appends a round and re-registers as a watcher.
  submit: async (id: string) => {
    const { feedbackIds } = backend.markPrompt(id);
    stopWatching(id);
    broadcast({ type: "submitted", reviewId: id });
    runAgentHandoff(id, feedbackIds);
    return { ok: true } as const;
  },

  getViewed: async (id: string) => backend.getViewed(id),
  setViewed: async (id: string, key: string, viewed: boolean) => backend.setViewed(id, key, viewed),

  addFeedback: async (reviewId: string, body: CreateFeedbackBody) =>
    backend.addFeedback(reviewId, body),
  editFeedback: async (id: string, body: { body?: string; status?: FeedbackStatus }) =>
    backend.editFeedback(id, body),
  reanchor: async (id: string, body: ReanchorBody) => backend.reanchor(id, body),
  deleteFeedback: async (id: string) => backend.deleteFeedback(id),
  addReply: async (feedbackId: string, body: AddReplyBody) => backend.addReply(feedbackId, body),
  editReply: async (id: string, body: UpdateReplyBody) => backend.editReply(id, body.body),

  // Quick-auth is meaningless with no server; keep the surface so components that
  // reference it still compile and behave sensibly.
  login: async () => ({ ok: true }) as const,
  logout: async () => ({ ok: true }) as const,
  authTokens: async () => [],
  createAuthToken: async (): Promise<never> => {
    throw new ApiError(400, "Login tokens aren't used in the demo.");
  },
  revokeAuthToken: async () => ({ ok: true }) as const,
};
