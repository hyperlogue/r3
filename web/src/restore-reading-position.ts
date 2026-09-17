import type { ReadingPosition } from "./reading-position.ts";

// Also serialized into the opaque preview. Wait for asynchronous layout, while
// allowing an explicit jump or the reader's next gesture to take over.
export function restoreReadingPosition(
  view: Window | HTMLElement,
  point: ReadingPosition,
  done: () => void,
  prepare: () => boolean = () => true,
): () => void {
  let frame = 0;
  let stopped = false;
  const deadline = performance.now() + 5000;
  const events = ["wheel", "touchstart", "pointerdown", "keydown"];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const event of events) view.removeEventListener(event, stop);
    done();
  };
  const attempt = () => {
    if (!prepare()) {
      if (performance.now() >= deadline) stop();
      else frame = requestAnimationFrame(attempt);
      return;
    }
    view.scrollTo({ left: point.x, top: point.y, behavior: "instant" });
    const x = view instanceof Window ? view.scrollX : view.scrollLeft;
    const y = view instanceof Window ? view.scrollY : view.scrollTop;
    if ((Math.abs(x - point.x) < 2 && Math.abs(y - point.y) < 2) || performance.now() >= deadline)
      stop();
    else frame = requestAnimationFrame(attempt);
  };
  for (const event of events) view.addEventListener(event, stop, { passive: true });
  frame = requestAnimationFrame(attempt);
  return stop;
}
