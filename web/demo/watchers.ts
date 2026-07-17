// Live-watcher presence for the demo. The real daemon tracks `r3 watch` clients
// (server/watchers.ts) so the feedback panel can flip from "Copy agent prompt" to
// "Submit to agent". Here there's no daemon and no CLI — the scripted agent
// (agent.ts) IS the watcher, so we keep a tiny in-memory registry and seed it on
// every review at startup. Presence is ephemeral (never persisted): a reload
// re-arms it, exactly like a fresh `r3 watch`.

import type { WatcherInfo } from "../../shared/types.ts";
import { broadcast } from "./bus.ts";
import { getState } from "./store.ts";

// The one scripted agent that watches every seeded review.
const AGENT: WatcherInfo = { session: "claude", agentId: "agent_demo" };

const watchers = new Map<string, WatcherInfo[]>();

export function getWatchers(reviewId: string): WatcherInfo[] {
  return watchers.get(reviewId) ?? [];
}

export function isWatching(reviewId: string): boolean {
  return (watchers.get(reviewId)?.length ?? 0) > 0;
}

// The agent re-registers as a watcher after finishing a hand-off (it "loops back
// to `r3 watch`"), so the panel returns to "Submit to agent" for the next round.
export function startWatching(reviewId: string, info: WatcherInfo = AGENT): void {
  watchers.set(reviewId, [info]);
  broadcast({ type: "watchers-changed", reviewId });
}

// The agent leaves `watch` to go work on a submitted round — the dot clears and
// the panel briefly falls back to "Copy prompt" until the agent re-arms.
export function stopWatching(reviewId: string): void {
  watchers.delete(reviewId);
  broadcast({ type: "watchers-changed", reviewId });
}

// Seed the scripted agent as a watcher on every review, so the demo opens in the
// "Submit to agent" state and the watch/submit loop is the default path. Called
// once at import (before anything subscribes), so it doesn't broadcast.
export function armDemoWatchers(): void {
  for (const r of getState().reviews) watchers.set(r.id, [AGENT]);
}
