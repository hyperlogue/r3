// The agent reply protocol text. The human clicks "Copy prompt for
// agent" (or the agent fetches the prompt via the CLI); the text embeds the
// review id + feedback ids and the exact CLI calls that round-trip decisions
// back into the live UI.
//
// Two builders share the header + block rendering: buildPrompt renders full
// threads (the GET/`r3 prompt --all` escape hatch, no marking), while
// buildUnsentPrompt renders only what the agent hasn't been sent — new feedback
// in full, and a compact follow-up block for feedback whose only new content is
// a human reply since the last hand-off — and reports exactly what it rendered
// so the caller can mark those rows sent.

import type { FeedbackWithReplies, Reply, ReviewDetail, ReviewSource } from "../shared/types.ts";
import { SUMMARY_FILE } from "../shared/types.ts";

function describeSource(kind: string, source: ReviewSource): string {
  if ("ref" in source) {
    if (source.ref === "SCRATCH") return "document";
    const n = source.files.length;
    return `files (${n} file${n === 1 ? "" : "s"} @ ${source.ref})`;
  }
  if ("base" in source)
    return source.base || source.head ? `diff ${source.base}..${source.head}` : "diff (piped)";
  return kind;
}

function locOf(fb: FeedbackWithReplies): string {
  // Summary feedback is anchored to prose, not a file — name which summary.
  if (fb.file === SUMMARY_FILE)
    return fb.patch_seq != null ? `diff ${fb.patch_seq} summary` : "review summary";
  if (!fb.file) return "(general)";
  const side = fb.side ? ` (${fb.side})` : "";
  const round = fb.patch_seq != null ? ` [diff ${fb.patch_seq}]` : "";
  // A real file path with no span is a whole-file note — say so, so the agent
  // reads it as "about this file" rather than an anchor that failed to resolve.
  if (fb.line_start == null) return `${fb.file} (whole file)${side}${round}`;
  const range =
    fb.line_end && fb.line_end !== fb.line_start
      ? `L${fb.line_start}-L${fb.line_end}`
      : `L${fb.line_start}`;
  return `${fb.file}:${range}${side}${round}`;
}

function feedbackBlock(fb: FeedbackWithReplies): string {
  const out: string[] = [];
  const stale =
    fb.anchor === "outdated" ? "  ⚠ anchor outdated — the code this refers to changed" : "";
  out.push(`### ${fb.id} — ${locOf(fb)} [${fb.status}]${stale}`);
  if (fb.quote) {
    for (const line of fb.quote.split("\n")) out.push(`> ${line}`);
  }
  out.push("");
  out.push(fb.body.trim());
  for (const r of fb.replies) {
    const tag = r.action ? `[${r.author} ${r.action}]` : `[${r.author}]`;
    out.push("");
    out.push(`  ${tag} ${r.body.trim()}`);
  }
  return out.join("\n");
}

// The prompt header: how to reply, a pointer to the full history, and the
// per-kind follow-up move. `count` is the number of items that follow.
function promptHeader(detail: ReviewDetail, count: number): string {
  const id = detail.id;
  // The follow-up moves differ by kind: a files review is a live
  // view (content re-anchors; the agent re-anchors explicitly after a
  // restructure), while a diff review is immutable rounds (the agent appends the
  // fix as a new round and pins replies into it).
  const followUp =
    detail.kind === "diff"
      ? `After making the changes, append them as a new diff round (tag it with a ` +
        `--summary of what changed overall), then pin each reply to where the fix ` +
        `landed in it:\n` +
        `  git diff <base>..<head> | r3 diff add ${id} --label "<title>" --summary "<what changed overall>"\n` +
        `  r3 reply <feedback_id> -m "<msg>" --diff <seq> --file <f> --line <a-b>\n`
      : `If your change moves the code a feedback points at, re-anchor it so it doesn't orphan:\n` +
        `  r3 reanchor <feedback_id> --file <f> --line <a-b> [--quote "<new text>"]\n`;
  // A short overview, if the human/agent set one, gives context before the items.
  const summary = detail.summary?.trim() ? `Summary: ${detail.summary.trim()}\n\n` : "";
  return (
    `Review \`${id}\` (${describeSource(detail.kind, detail.source)}) — ${count} feedback item${count === 1 ? "" : "s"}. ` +
    `Work through each, then reply by feedback id so it appears in my review UI ` +
    `(say what you changed, why you disagree, or any follow-up — it's all just a reply):\n\n` +
    summary +
    `  r3 reply <feedback_id> -m "<msg>"\n` +
    `  r3 show ${id}   # full history — every item and thread, including what's already been sent\n\n` +
    followUp
  );
}

// The candidate set for a prompt: open + accepted feedback (the working set the
// agent still acts on; resolved/refuted are settled).
function isCandidate(fb: FeedbackWithReplies): boolean {
  return fb.status === "open" || fb.status === "accepted";
}

// A feedback has content the agent hasn't been sent yet: the feedback itself was
// never delivered, or a human reply was posted since the last hand-off. Agent
// replies never count — the agent wrote them.
function hasUnsentContent(fb: FeedbackWithReplies): boolean {
  return fb.sent_at == null || fb.replies.some((r) => r.author === "human" && r.sent_at == null);
}

// Full-history prompt (GET /api/reviews/:id/prompt, `r3 prompt --all`): every
// candidate item with its whole thread, no marking. `feedbackIds` narrows to a
// specific subset. This is the escape hatch that always re-prints everything.
export function buildPrompt(detail: ReviewDetail, opts: { feedbackIds?: string[] } = {}): string {
  const only = opts.feedbackIds;
  const items = only?.length
    ? detail.feedback.filter((f) => only.includes(f.id))
    : detail.feedback.filter(isCandidate);
  const header = promptHeader(detail, items.length);
  if (items.length === 0) return `${header}\n(no open feedback items)\n`;
  return `${header}\n${items.map(feedbackBlock).join("\n\n")}\n`;
}

// A compact block for feedback the agent has already seen but that gained a new
// human reply — only the new replies, with a pointer to the full thread. Named
// "(follow-up)" so the header row is unmistakable next to a full block.
function followUpBlock(reviewId: string, fb: FeedbackWithReplies, replies: Reply[]): string {
  const out: string[] = [`### ${fb.id} — ${locOf(fb)} [${fb.status}] (follow-up)`];
  for (const r of replies) {
    const tag = r.action ? `[${r.author} ${r.action}]` : `[${r.author}]`;
    out.push("");
    out.push(`  ${tag} ${r.body.trim()}`);
  }
  out.push("");
  out.push(`  (earlier discussion omitted — run \`r3 show ${reviewId}\` for the full thread)`);
  return out.join("\n");
}

// What buildUnsentPrompt rendered, so the caller marks exactly those rows sent.
export interface UnsentPrompt {
  text: string;
  included: { feedback: string[]; replies: string[] };
}

// Unsent-only prompt (POST /api/reviews/:id/prompt, `r3 prompt` / `r3 watch`):
// only feedback the agent hasn't seen — new feedback rendered in full, and a
// compact follow-up block for feedback whose only new content is a human reply.
// `feedbackIds` narrows the candidates but never forces already-sent content
// back in. Reports the ids it rendered so the caller can mark precisely those.
export function buildUnsentPrompt(
  detail: ReviewDetail,
  opts: { feedbackIds?: string[] } = {},
): UnsentPrompt {
  const only = opts.feedbackIds;
  let candidates = detail.feedback.filter((f) => isCandidate(f) && hasUnsentContent(f));
  if (only?.length) candidates = candidates.filter((f) => only.includes(f.id));
  const header = promptHeader(detail, candidates.length);
  const included = { feedback: [] as string[], replies: [] as string[] };
  if (candidates.length === 0) {
    return {
      text: `${header}\n(no unsent feedback — run \`r3 show ${detail.id}\` for the full history)\n`,
      included,
    };
  }
  const blocks: string[] = [];
  for (const fb of candidates) {
    if (fb.sent_at == null) {
      // Never delivered — render the whole item (quote, body, thread) as today.
      blocks.push(feedbackBlock(fb));
      included.feedback.push(fb.id);
      for (const r of fb.replies) included.replies.push(r.id);
    } else {
      // Already delivered; only the new human replies are unsent.
      const unsent = fb.replies.filter((r) => r.author === "human" && r.sent_at == null);
      blocks.push(followUpBlock(detail.id, fb, unsent));
      for (const r of unsent) included.replies.push(r.id);
    }
  }
  return { text: `${header}\n${blocks.join("\n\n")}\n`, included };
}
