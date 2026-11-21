import type { PreviewViewport } from "../../shared/preview-protocol.ts";

// Called only for the current Locate nonce on the verified document port. A
// quote can lie far from its containing element's center in a fitted document.
export function scrollPreviewQuote(iframe: HTMLIFrameElement, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const { top, bottom } = value as PreviewViewport;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top) return;
  const header = iframe.closest("[data-file]")?.querySelector("[data-file-header]");
  for (let node = iframe.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.overflowY === "visible" ||
      style.overflowY === "clip" ||
      node.scrollHeight <= node.clientHeight
    )
      continue;
    const inset =
      (Number.parseFloat(style.getPropertyValue("--pane-sticky-h")) || 0) +
      (header?.getBoundingClientRect().height ?? 0);
    node.scrollBy({
      top:
        iframe.getBoundingClientRect().top +
        top -
        node.getBoundingClientRect().top -
        node.clientTop -
        inset -
        Math.max(0, (node.clientHeight - inset - (bottom - top)) / 2),
      behavior: "instant",
    });
  }
}

// A full-height iframe's viewport is the document, but its comment controls
// belong in the portion exposed by the surrounding file stack.
export function observePreviewViewport(
  iframe: HTMLIFrameElement,
  send: (viewport: PreviewViewport) => void,
): () => void {
  const ancestors: HTMLElement[] = [];
  for (let node = iframe.parentElement; node; node = node.parentElement) ancestors.push(node);
  const header = iframe.closest("[data-file]")?.querySelector("[data-file-header]");
  let frame = 0;
  let previous = "";
  const measure = () => {
    frame = 0;
    const rect = iframe.getBoundingClientRect();
    let top = Math.max(0, rect.top);
    let bottom = Math.min(innerHeight, rect.bottom);
    let left = Math.max(0, rect.left);
    let right = Math.min(innerWidth, rect.right);
    for (const node of ancestors) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const bounds = node.getBoundingClientRect();
      if (style.overflowY !== "visible") {
        top = Math.max(top, bounds.top + node.clientTop);
        bottom = Math.min(bottom, bounds.top + node.clientTop + node.clientHeight);
      }
      if (style.overflowX !== "visible") {
        left = Math.max(left, bounds.left + node.clientLeft);
        right = Math.min(right, bounds.left + node.clientLeft + node.clientWidth);
      }
    }
    if (header) top = Math.max(top, header.getBoundingClientRect().bottom);
    const viewport = {
      top: Math.max(0, top - rect.top),
      bottom: Math.max(0, bottom - rect.top),
      left: Math.max(0, left - rect.left),
      right: Math.max(0, right - rect.left),
    };
    const key = JSON.stringify(viewport);
    if (key !== previous) {
      previous = key;
      send(viewport);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const observer = new ResizeObserver(schedule);
  for (const node of [iframe, ...ancestors]) observer.observe(node);
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
  };
}
