import { hrefFor, navigate } from "../router.ts";

// Navbar "Reviews" breadcrumb. A real anchor so middle-click / ⌘-click open a
// new tab; left-click stays in-app.
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
