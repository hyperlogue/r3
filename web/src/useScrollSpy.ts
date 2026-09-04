// The scroll-spy: which file block the reader is mostly looking at. That answer
// is `activePath`, one of the view's two cursors — every per-file shortcut
// (`]`/`[`, `z`, `x`, `a`) targets it, and the file browser and picker mark it —
// so it lives here rather than inline in a view that has plenty else to do.

import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo } from "react";

// Hand "current file" to the next block once the one above is down to this share
// of pane height. Wholly-visible blocks are exempt.
const ACTIVE_HANDOFF_SHARE = 0.15;

export function useScrollSpy(input: {
  /** The scroll pane holding the [data-file] blocks. */
  paneRef: RefObject<HTMLElement | null>;
  setActivePath: Dispatch<SetStateAction<string | null>>;
  /**
   * A jump owns activePath while its animation flies — mid-flight frames must
   * not re-spy it back to a block the ride is passing through.
   */
  suspended: RefObject<boolean>;
  /** Re-attach trigger: false while the view renders its loading state instead. */
  ready: boolean;
  /** Re-measure trigger: the file set the pane currently renders. */
  fileList: readonly string[];
}): void {
  const { paneRef, setActivePath, suspended, ready, fileList } = input;
  // The rule is "the first file block still showing in the pane — unless it's
  // nearly gone and something follows it." A crossed-scanline test (what this was)
  // only hands over once the NEXT file reaches the top, so the marker stayed on a
  // file reduced to a sliver while its successor filled the screen. Handing over
  // at ACTIVE_HANDOFF_SHARE means the marker moves while you're still scrolling
  // toward the next file, which is when you've already started reading it.
  //
  // The `clipped` half of the test is what keeps small blocks safe: a folded file
  // is one 2rem header and can NEVER occupy 15% of the pane, so a bare share test
  // would skip past every folded file — and `]`/`[` index on activePath, so
  // stepping onto one would immediately report the file after it. A block that is
  // wholly on screen is never handed off, whatever its size.
  //
  // The measure reads the DOM live — off a block list re-scanned whenever the
  // pane's content resizes — so it stays correct as blocks load/render without
  // re-subscribing. Keyed on `ready` (not []) because the first commit
  // early-returns "Loading review…" — scopeRef is null there, and a one-shot
  // effect would never attach on a cold load.
  //
  // ALSO keyed on the rendered file set: a version switch swaps the pane's blocks
  // without touching `detail` or firing a scroll. Per-file shortcuts MUTATE against
  // activePath, so a stale one writes a viewed mark no card reads / opens a
  // whole-file note the server rejects. Re-measure on the swap.
  const fileListKey = useMemo(() => fileList.join("\n"), [fileList]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` + the rendered file set are the re-attach/re-measure triggers; the listener reads the DOM, not either object
  useEffect(() => {
    const root = paneRef.current;
    if (!root) return;
    let raf = 0;
    // The pane's blocks in document order, plus the subset an IntersectionObserver
    // rooted on the pane currently reports as showing. Measuring every block cost
    // a forced layout per file per frame — on a 200-file review nearly all of them
    // for files scrolled far off the top — and re-querying the DOM each frame paid
    // for the list again. The observer only narrows the candidates; the rect tests
    // below still decide, so the rule is exactly the one described above.
    let blocks: HTMLElement[] = [];
    let index = new Map<Element, number>();
    const observed = new Set<Element>();
    const showing = new Set<Element>();
    let order: number[] = [];
    let orderStale = true;
    // An empty showing set reads exactly like "nothing intersects", which hands
    // the marker to the LAST block — so sit out until the observer has spoken
    // once rather than answering from a set that isn't populated yet.
    let delivered = false;

    const measure = () => {
      raf = 0;
      // A toolbar jump owns activePath while its animation flies — mid-flight
      // frames must not re-spy it back to a block the ride is passing through.
      if (suspended.current) return;
      if (!delivered && blocks.length > 0) return;
      const pane = root.getBoundingClientRect();
      // Measured against the pane's own box, NOT the sticky band: while a file is
      // current the band holds that file's own header, so it isn't lost height.
      const paneH = pane.height;
      const last = blocks[blocks.length - 1] ?? null;
      // At the end of the scroll there is nothing left to scroll toward, so the
      // last block takes the marker outright. Without this a final file shorter
      // than ~85% of the pane could never win the test below — the file before it
      // still fills the screen — so it would never be current, and `]` (which
      // indexes on activePath) would stick on its predecessor forever.
      //
      // Only when there IS something to scroll. A pane whose content fits is at
      // its end from the first frame, and handing the marker to the last file
      // there is backwards — nothing has been scrolled past. That's also what a
      // cold load looks like: the first measure runs before the content exists
      // (a files review renders one small [data-file] stub per file until its
      // blob lands), so the marker went to the LAST file while the reader was
      // looking at the first. Fall through instead — every block is wholly
      // visible then, so the walk below marks the first one.
      const atEnd =
        root.scrollHeight > root.clientHeight + 1 &&
        root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
      let current: string | null = atEnd ? (last?.getAttribute("data-file") ?? null) : null;
      if (orderStale) {
        order = [];
        for (const el of showing) {
          const at = index.get(el);
          if (at != null) order.push(at);
        }
        order.sort((a, b) => a - b);
        orderStale = false;
      }
      // Walk the showing blocks in document order. The observer computes its set
      // after the previous frame's callbacks, so a fast flick can hand us one
      // whose members have all just left the top of the pane; stepping on to the
      // block after the last of those lands on the same answer a full scan would.
      let k = 0;
      let i = order.length > 0 ? order[0] : -1;
      while (!current && i >= 0 && i < blocks.length) {
        const r = blocks[i].getBoundingClientRect();
        if (r.bottom <= pane.top + 1) {
          // scrolled off the top entirely
          k++;
          i = k < order.length ? Math.max(order[k], i + 1) : i + 1;
          continue;
        }
        if (r.top >= pane.bottom) break; // this one and everything after is below
        // How much of this block the pane is actually showing.
        const shown = Math.min(r.bottom, pane.bottom) - Math.max(r.top, pane.top);
        const clipped = shown < r.height - 1;
        const next = blocks[i + 1];
        current =
          next && clipped && shown < paneH * ACTIVE_HANDOFF_SHARE
            ? next.getAttribute("data-file")
            : blocks[i].getAttribute("data-file");
        break;
      }
      // Nothing intersects (trailing padding under the last block, or a pane
      // shorter than its own chrome) — keep the last file rather than dropping to
      // null, which would unbind every per-file shortcut mid-scroll.
      setActivePath(current ?? last?.getAttribute("data-file") ?? null);
    };
    // rAF-throttle: a wheel/trackpad flick fires many scroll events per frame, but
    // the spy only needs to run once per painted frame. Coalesce them so a fast
    // scroll doesn't repeat the rect reads dozens of times between frames.
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) showing.add(e.target);
          else showing.delete(e.target);
        }
        delivered = true;
        orderStale = true;
        // What just changed is what the next frame measures against.
        schedule();
      },
      { root },
    );
    // Re-point the observer whenever the pane's block list actually changes: a
    // version switch swaps every block, and a large files review paints its stubs
    // over several commits. The one place the DOM is queried for them.
    const rescan = () => {
      const next = [...root.querySelectorAll<HTMLElement>("[data-file]")];
      if (next.length === blocks.length && next.every((el, at) => el === blocks[at])) return;
      const live = new Set<Element>(next);
      for (const el of [...observed]) {
        if (live.has(el)) continue;
        io.unobserve(el);
        observed.delete(el);
        showing.delete(el);
      }
      for (const el of next) {
        if (observed.has(el)) continue;
        io.observe(el);
        observed.add(el);
      }
      blocks = next;
      index = new Map(next.map((el, at) => [el, at]));
      orderStale = true;
    };

    root.addEventListener("scroll", schedule, { passive: true });
    // The pane's content mostly arrives AFTER this effect, and none of it fires a
    // scroll event: a files review paints [data-file] stubs until each blob lands,
    // and a fold/unfold restacks everything below it. Without a resize signal the
    // marker would keep whatever it computed against the stubs — the reported "the
    // first file isn't marked on open". The pane's OWN box is worth watching too:
    // its height is the 15% denominator, so a feedback-panel drag or a window
    // resize changes the answer. The pane has exactly one child — the stacked file
    // content (VirtualPaneProvider's wrapper) — so its height is the content height.
    // A restack can also add or drop blocks, so the rescan rides the same signal.
    const onContent = () => {
      rescan();
      schedule();
    };
    const ro = new ResizeObserver(onContent);
    ro.observe(root);
    if (root.firstElementChild) ro.observe(root.firstElementChild);
    rescan();
    measure();
    return () => {
      root.removeEventListener("scroll", schedule);
      ro.disconnect();
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ready, fileListKey]);
}
