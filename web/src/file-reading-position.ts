import type { FileReadingAnchor, ReadingPosition } from "./reading-position.ts";

// Persist a location inside a file rather than a sum of all preceding heights.
// Unopened shells may have different heights after a reload or viewport resize.
export function captureFileReadingAnchor(pane: HTMLElement): FileReadingAnchor | undefined {
  const top = pane.getBoundingClientRect().top;
  const toolbar =
    Number.parseFloat(getComputedStyle(pane).getPropertyValue("--pane-sticky-h")) || 0;
  for (const file of pane.querySelectorAll<HTMLElement>("[data-progressive-file]")) {
    const rect = file.getBoundingClientRect();
    if (rect.bottom > top + toolbar && rect.height > 0 && file.dataset.file)
      return { path: file.dataset.file, offset: top - rect.top };
  }
}

export function resolveFileReadingPosition(
  pane: HTMLElement,
  point: ReadingPosition,
  anchor: FileReadingAnchor,
  activate: (path: string) => boolean,
): (ReadingPosition & { ready: boolean }) | null {
  const file = pane.querySelector<HTMLElement>(
    `[data-progressive-file][data-file="${CSS.escape(anchor.path)}"]`,
  );
  if (!file) return null;
  if (file.dataset.progressiveFile === "inactive") activate(anchor.path);
  const rect = file.getBoundingClientRect();
  const ready =
    file.dataset.progressiveFile === "active" &&
    !file.matches('[aria-busy="true"]') &&
    !file.querySelector('[aria-busy="true"]');
  // A deep offset may exceed the target's provisional height. Keep the viewport
  // inside that shell until it grows, or restoring would open following files
  // before the saved document has even arrived. Passive cached content may grow
  // the shell before preview admission, and remains readable at the saved offset.
  const offset = ready
    ? anchor.offset
    : Math.min(anchor.offset, Math.max(0, rect.height - pane.clientHeight));
  // Reveal the target shell immediately, then keep its local offset aligned as
  // its own content settles. No preceding publication bytes are needed.
  return {
    x: point.x,
    y: Math.max(0, pane.scrollTop + rect.top - pane.getBoundingClientRect().top + offset),
    ready,
  };
}
