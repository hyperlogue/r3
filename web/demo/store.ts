// The demo's persistence: one JSON blob in localStorage, seeded from the
// build-time fixtures. Every backend mutation calls persist() so edits (feedback,
// replies, resolves, agent rounds) survive a reload; resetDemo() restores the
// pristine seed. There is no server — this module is the whole storage layer.

import { SEED } from "./fixtures.gen.ts";
import type { DemoState } from "./model.ts";

const KEY = "r3-demo-state";
// Bump when the seed/row shape changes: an older stored blob won't match and the
// browser falls back to a fresh seed instead of rendering against a stale schema.
const VERSION = 1;

function seedState(): DemoState {
  // structuredClone so mutating the store never reaches back into the frozen SEED.
  return { version: VERSION, viewed: {}, ...structuredClone(SEED) };
}

function readStored(): DemoState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    return parsed.version === VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function write(s: DemoState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Quota / private-mode failures are non-fatal — the demo keeps working from
    // in-memory state for this session; it just won't persist across reloads.
  }
}

let state: DemoState =
  readStored() ??
  (() => {
    const s = seedState();
    write(s);
    return s;
  })();

export function getState(): DemoState {
  return state;
}

export function persist(): void {
  write(state);
}

// Clear all demo edits back to the seeded reviews (the Reset button).
export function resetDemo(): void {
  state = seedState();
  write(state);
}

// A stable, cheap content hash for feedback.code_sha. The real server uses a
// git blob sha, but code_sha is only recorded, never compared (staleness is
// surfaced via `anchor`), so any stable digest is faithful to observed behaviour.
export function contentSha(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function mintId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
