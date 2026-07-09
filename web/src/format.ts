// Display formatting shared across views, kept here so the reviews-list row and
// the review header can't drift (they used to hand-roll `sourceLabel` separately,
// with subtly different sha lengths, separators, and file-count wording).

import type { Review } from "./types.ts";

// Reviews-list ranking: an agent blocked on `r3 watch` floats to the
// top (someone's waiting on it right now), then open work, then approved, then
// abandoned. Within a tier, most-recently-updated first. Lives here so the home
// list (and the future quick-switch popup) can't drift out of order.
function reviewRank(r: Review): number {
  if (r.watching) return 0;
  switch (r.status) {
    case "open":
      return 1;
    case "approved":
      return 2;
    case "abandoned":
      return 3;
    default:
      return 4;
  }
}

export function sortReviews(reviews: Review[]): Review[] {
  return [...reviews].sort(
    (a, b) => reviewRank(a) - reviewRank(b) || b.updated_at.localeCompare(a.updated_at),
  );
}

// Status → dot classes. `open` is a HOLLOW indigo ring — work in progress with
// nobody watching. A live watcher overrides this at the call site with a SOLID
// indigo dot (same hue, filled in to say "an agent is on it right now"), matching
// the feedback panel's "watching" indicator. The terminal states keep a solid
// colored dot — approved green, abandoned gray — so a finished review still reads
// at a glance; green is theirs alone now (it no longer doubles as "watching").
export const STATUS_DOT: Record<string, string> = {
  open: "border border-primary-500",
  approved: "bg-success-500",
  abandoned: "bg-neutral-300 dark:bg-neutral-600",
};

export const shortSha = (s: string) => (/^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, 7) : s);

// A terse label for a review's source: the sha range for a `diff`, the file
// count for `files`, or a word for the sentinel sources (a SCRATCH document, or
// a git-provenance-less piped diff). Pass `{ ref: true }` for the long form
// ("N files @ ref") used in the review header; the short form ("N files") suits
// the sidebar.
export function sourceLabel(
  { kind, source }: Pick<Review, "kind" | "source">,
  opts: { ref?: boolean } = {},
): string {
  if ("files" in source) {
    if (source.ref === "SCRATCH") return "document";
    const n = source.files.length;
    const label = `${n} file${n === 1 ? "" : "s"}`;
    // WORKING is the implicit default ("a live view of now"), so "@ WORKING" is
    // noise on the common case — annotate only a *pinned* ref/sha the reader
    // wouldn't otherwise expect.
    return opts.ref && source.ref !== "WORKING" ? `${label} @ ${source.ref}` : label;
  }
  if ("base" in source) {
    if (!source.base && !source.head) return "diff"; // piped in, no git provenance
    return `${shortSha(source.base)}..${shortSha(source.head)}`;
  }
  return kind;
}
