// In-review doc links: click an `a.r3-doclink` to jump to that file's card.

// A doc link parsed off a clicked anchor. `hash` is a heading slug matching the
// `data-r3-heading` the server tags headings with; null when the link named none.
export interface DocLink {
  file: string;
  hash: string | null;
}

// Read the doc link a click landed on, if any (a click inside a link's `<code>`
// or `<strong>` counts). null when the click wasn't on one.
export function docLinkFromEvent(target: EventTarget | null): DocLink | null {
  const el = target instanceof Element ? target.closest("a.r3-doclink") : null;
  if (!el) return null;
  const file = el.getAttribute("data-r3-doc-file");
  if (!file) return null;
  return { file, hash: el.getAttribute("data-r3-doc-hash") || null };
}

// Mark the doc links whose target isn't part of this review — a doc set is
// rarely reviewed whole, so `[…](../CONTRIBUTING.md)` is normal and has nowhere
// to jump. Marking them dims the link and explains itself on hover; without it
// the click would just silently do nothing, which is the bug this whole feature
// fixes. Runs over server HTML that React owns via dangerouslySetInnerHTML, so
// it's an imperative pass (like web/src/highlights.ts) re-run whenever the HTML
// or the membership changes.
export function markMissingDocLinks(root: HTMLElement | null, has: (path: string) => boolean) {
  if (!root) return;
  for (const el of root.querySelectorAll<HTMLElement>("a.r3-doclink")) {
    const file = el.getAttribute("data-r3-doc-file");
    const missing = !file || !has(file);
    el.classList.toggle("r3-doclink-missing", missing);
    if (missing) el.title = `${file || "?"} — not part of this review`;
  }
}
