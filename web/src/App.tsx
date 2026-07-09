import { useEffect, useRef } from "react";
import { Logo, type LogoHandle } from "./components/Logo.tsx";
import { ReviewSwitcher } from "./components/ReviewSwitcher.tsx";
import { SettingsPopup } from "./components/SettingsPopup.tsx";
import { useServerEvents } from "./hooks.ts";
import { Home } from "./pages/Home.tsx";
import { ReviewView } from "./pages/ReviewView.tsx";
import { useRoute } from "./router.ts";

function Header() {
  // The logo click doesn't navigate (Home is the `/` landing) — it's purely a
  // fidget toy: it spins the mark's spikes (Logo.flick), stacking momentum on
  // each click. The navbar always carries the "Reviews" breadcrumb back to the
  // home list, so navigation lives here rather than inside the review's own header.
  const logo = useRef<LogoHandle>(null);
  return (
    <header className="flex h-[2rem] shrink-0 items-center justify-between border-b border-neutral-300 bg-white pl-3 dark:border-neutral-700 dark:bg-neutral-950">
      <div className="flex min-w-0 items-center gap-2 self-stretch">
        <button
          type="button"
          onClick={() => logo.current?.flick()}
          className="group flex shrink-0 cursor-pointer items-center gap-1.5 text-sm font-semibold text-neutral-800 dark:text-neutral-100"
        >
          <Logo
            ref={logo}
            className="size-5 transition-transform duration-75 group-active:scale-90"
          />
          r3
        </button>
        {/* The "Reviews" breadcrumb is always present — the reviews list is a page
            (Home), so this is the way back to it whether or not a review is open. */}
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />
        <ReviewSwitcher />
      </div>
      <SettingsPopup />
    </header>
  );
}

export function App() {
  const { reviewId } = useRoute();
  // One global SSE subscription keeps the reviews list + any open review live.
  useServerEvents(reviewId ?? undefined);

  // The document title tracks the open review (ReviewView sets it); reset to the
  // bare app name whenever no review is selected.
  useEffect(() => {
    if (!reviewId) document.title = "r3";
  }, [reviewId]);

  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Header />
      <main className="min-h-0 flex-1 overflow-hidden">
        {/* Keyed by id so switching reviews remounts: per-review state (the draft
            composer, viewed set, scroll) initializes fresh for each. No review →
            the reviews home list (the review list is a page now, not a sidebar). */}
        {reviewId ? <ReviewView key={reviewId} reviewId={reviewId} /> : <Home />}
      </main>
    </div>
  );
}
