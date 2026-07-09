// Short, prefixed, sortable-enough ids. Not cryptographic — just collision-
// resistant local handles the agent can reference (e.g. `feedback_a1b2c3`).

import { randomBytes } from "node:crypto";

function short(n = 12): string {
  // Fixed-width lowercase hex (base16) from random bytes. n hex chars = n·4 bits
  // of entropy (default 12 → 48 bits): a birthday collision within one id space
  // only becomes non-negligible around 2^24 ids, orders of magnitude past any
  // real local store. The insert paths in db.ts still retry on the vanishing
  // chance of a PRIMARY KEY clash, so a collision degrades to a re-mint, never a
  // lost write. Draw enough bytes to cover n hex chars (ceil(n/2)).
  return randomBytes(Math.ceil(n / 2))
    .toString("hex")
    .slice(0, n);
}

export const newReviewId = () => `review_${short()}`;
export const newFeedbackId = () => `feedback_${short()}`;
export const newReplyId = () => `reply_${short()}`;
export const newRepoId = () => `repo_${short()}`;

export function nowIso(): string {
  return new Date().toISOString();
}
