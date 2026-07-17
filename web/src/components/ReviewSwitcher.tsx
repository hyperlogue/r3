import { hrefFor, navigate } from "../router.ts";

// The "Reviews" breadcrumb back to the reviews home list — always present in the
// top navbar (App.Header), whether or not a review is open — the reviews list is
// a full page (Home) now, not a docked sidebar. A real anchor (it navigates), so
// middle-click / ⌘-click open the list in a new tab natively while a plain
// left-click stays in-app (preventDefault + navigate); that also gives it the
// native link cursor for free. A full-height, square (un-rounded) navbar cell;
// hover just brightens the text (no background) so it reads as a plain nav link.
// A quick-switch popup panel (jump to another review) will live here in the future.
export function ReviewSwitcher() {
  return (
    <a
      href={hrefFor("/")}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate("/");
      }}
      title="All reviews"
      className="flex h-full shrink-0 items-center px-2 text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
    >
      Reviews
    </a>
  );
}
