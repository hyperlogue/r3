// Scripted demo agent: on Submit, claim + reply (and on a diff review's first
// hand-off, append a round and pin). Then re-register as a watcher.

import { addReply, appendRound, claimFeedback, getFeedback, getReview } from "./backend.ts";
import { getState } from "./store.ts";
import { startWatching } from "./watchers.ts";

// How long the "agent" appears to be working before its replies land.
const AGENT_DELAY = 1400;

// Classic coding-agent catchphrases — deliberately a little over-eager. The first
// one (used for the pinned reply on a diff review) always leads with the meme.
const ACKS = [
  "You're absolutely right! Great catch — I've updated `{file}` to handle this.",
  "You're absolutely right — nice one. Fixed in `{file}`; shout if you'd prefer a different approach.",
  "Excellent point! You're absolutely right, and I've reworked `{file}` accordingly.",
  "You're absolutely right to flag that. Handled in `{file}` — I kept the change minimal.",
];

function ackFor(file: string, i: number): string {
  const label = file && file !== "@summary" ? file : "the review";
  return ACKS[i % ACKS.length].replace("{file}", label);
}

// Find a valid pin inside a round: the first file with an added line, and that
// line's text as the quote (so validateReplyPin passes by construction).
function pinInRound(round: {
  files: {
    path: string;
    oldPath: string | null;
    lines: { type: string; newLine: number | null; text: string }[];
  }[];
}): { file: string; line: number; quote: string } | null {
  for (const f of round.files) {
    const add = f.lines.find((ln) => ln.type === "add" && ln.newLine != null && ln.text.trim());
    if (add) return { file: f.path, line: add.newLine as number, quote: add.text };
  }
  return null;
}

// One flight per review at a time keeps replies from interleaving on a rapid
// re-submit; reviews are independent.
const inFlight = new Set<string>();

export function runAgentHandoff(reviewId: string, feedbackIds: string[]): void {
  if (inFlight.has(reviewId)) return;
  inFlight.add(reviewId);
  // Claim immediately after leaving `watch`, so the panel shows active work
  // throughout the scripted delay. The agent replies below release each claim.
  for (const id of feedbackIds) {
    const fb = getFeedback(id);
    if (fb?.author === "human" && fb.status === "open")
      claimFeedback(id, { session: "claude", agentId: "agent_demo" });
  }
  window.setTimeout(() => {
    try {
      const rv = getReview(reviewId);
      if (!rv) return;
      // Only respond to the human's own open items — the agent doesn't reply to
      // its own feedback (that would echo forever).
      const targets = feedbackIds
        .map((id) => getFeedback(id))
        .filter(
          (f): f is NonNullable<typeof f> => !!f && f.author === "human" && f.status === "open",
        );
      if (targets.length) {
        // On a diff review, land the fix as a new round the first time, then pin
        // the first reply to it — the rest are plain acknowledgements.
        let pinnedTo: number | null = null;
        let pin: ReturnType<typeof pinInRound> = null;
        if (rv.kind === "diff") {
          const pending = getState().pendingRounds.filter((p) => p.review_id === reviewId);
          if (pending.length) {
            const next = pending[0];
            getState().pendingRounds = getState().pendingRounds.filter((p) => p !== next);
            pinnedTo = appendRound(reviewId, {
              label: next.label,
              summary: next.summary,
              files: next.files,
              // The baked full-context rows are what diffContext slices; dropping
              // them here left the appended round with no expandable source, so
              // every expander on round 2 404'd (see fullForRound).
              fullFiles: next.fullFiles,
            });
            pin = pinInRound(next);
          }
        }

        targets.forEach((fb, i) => {
          const usePin = i === 0 && pinnedTo != null && pin != null;
          addReply(fb.id, {
            author: "agent",
            body: ackFor(fb.file, i),
            ...(usePin
              ? {
                  patchSeq: pinnedTo as number,
                  file: pin!.file,
                  lineStart: pin!.line,
                  lineEnd: pin!.line,
                  quote: pin!.quote,
                }
              : {}),
          });
        });
      }
    } finally {
      inFlight.delete(reviewId);
      // The agent loops back to `r3 watch` — re-register as a watcher so the
      // panel returns to "Submit to agent" (and the "● watching" dot reappears).
      startWatching(reviewId);
    }
  }, AGENT_DELAY);
}
