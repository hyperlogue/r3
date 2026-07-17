// The demo's nav-bar chrome: a persistent "Live demo" badge that sits beside the
// settings gear, plus a first-run intro dialog that explains this is a browser-only
// demo. The daemon never sees this — web/src/demo-chrome.tsx is a no-op stub that
// the demo build aliases to this module (scripts/build-demo.ts). Clicking the badge
// re-opens the intro; the intro carries the Reset action (restore the seeded state).

import { useCallback, useEffect, useState } from "react";
import { hrefFor } from "../src/router.ts";
import { Button, cn } from "../src/ui.tsx";
import { resetDemo } from "./store.ts";

// One-per-browser flag so the intro auto-opens only on the first visit.
const SEEN_KEY = "r3-demo-intro-seen";

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) != null;
  } catch {
    return true; // no storage (private mode) → don't nag on every render
  }
}

export function DemoChrome() {
  const [open, setOpen] = useState(() => !seen());

  // Stable (no deps) so the Escape effect below doesn't re-bind every render.
  const close = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // best-effort; the intro just re-shows next reload if storage is unavailable
    }
    setOpen(false);
  }, []);

  function reset() {
    if (
      !confirm(
        "Reset the demo? This clears all feedback, replies, and edits back to the seeded reviews.",
      )
    )
      return;
    resetDemo();
    // Back to the demo's own root (e.g. /r3/demo/, not the site root "/"), re-seeded.
    location.href = hrefFor("/");
  }

  // Escape closes the intro, matching the settings popup.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // The badge and the Reset pill share px-2/py-0.5/text-[0.7rem]/rounded-full, so
  // the two sit as an equal-height, matched pair to the left of the settings gear.
  return (
    <>
      <div className="mr-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="This runs entirely in your browser — no server. Click for a quick intro."
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary-300 bg-primary-50 px-2 py-0.5 text-[0.7rem] font-medium text-primary-700 transition-colors hover:bg-primary-100 dark:border-primary-800/70 dark:bg-primary-950/50 dark:text-primary-300 dark:hover:bg-primary-900/50"
        >
          <span className="size-1.5 rounded-full bg-primary-500" aria-hidden="true" />
          Live demo
        </button>
        <button
          type="button"
          onClick={reset}
          title="Reset the demo — discard your edits and restore the seeded reviews"
          className="inline-flex shrink-0 items-center rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-[0.7rem] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          ⟳ Reset
        </button>
      </div>

      {open && <IntroDialog onClose={close} onReset={reset} />}
    </>
  );
}

function IntroDialog({ onClose, onReset }: { onClose: () => void; onReset: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* backdrop — click to dismiss */}
      <button
        type="button"
        aria-label="Close intro"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-intro-title"
        className="relative z-10 w-full max-w-md overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-950"
      >
        <div className="px-5 py-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-2 py-0.5 text-[0.7rem] font-medium text-primary-700 dark:bg-primary-950/50 dark:text-primary-300">
            <span className="size-1.5 rounded-full bg-primary-500" aria-hidden="true" />
            Live demo
          </span>
          <h2 id="demo-intro-title" className="mt-2.5 text-base font-semibold">
            You're looking at a demo of r3
          </h2>
          <div className="mt-2 space-y-2 text-sm text-neutral-600 dark:text-neutral-300">
            <p>
              This is{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-100">
                just a demo
              </span>{" "}
              — the whole thing runs in your browser. There's no server: the reviews, your feedback,
              and the AI agent all live in this tab and save to local storage.
            </p>
            <p>
              Two reviews of r3's <em>own</em> code are loaded. Open one, leave feedback on a line
              or the summary, then click{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-100">
                Submit to agent
              </span>{" "}
              — a scripted agent replies (and, on the diff review, pushes a follow-up round) live.
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Your changes persist in this browser. Use Reset to restore the original seed.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50 px-5 py-3 dark:border-neutral-800 dark:bg-neutral-900/50">
          <button
            type="button"
            onClick={onReset}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800",
            )}
          >
            ⟳ Reset demo
          </button>
          <Button variant="primary" onClick={onClose}>
            Explore →
          </Button>
        </div>
      </div>
    </div>
  );
}
