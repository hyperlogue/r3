import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api.ts";
import { clearDraft, useHasDraft } from "../drafts.ts";
import { STATUS_DOT, sortReviews, sourceLabel } from "../format.ts";
import { hrefFor, navigate } from "../router.ts";
import type { RepoRecord, Review } from "../types.ts";
import { cn } from "../ui.tsx";

// The reviews home page — the app's landing view at `/`. Reviews are created from
// the CLI / agent (there's no in-browser repo browser), so this ranked list is
// how you pick what to work on; opening one navigates to `/<id>`. Replaces the
// old docked sidebar so a review gets the full window width for file + feedback.

// A repo's path stems, e.g. /Users/dev/code/r3/.git -> ["Users","dev","code","r3"].
// `commonDir` is the git object store; strip a trailing `.git` (a normal checkout)
// so the basename is the project dir, not ".git".
function repoSegments(r: RepoRecord): string[] {
  const p = r.commonDir.replace(/\/+$/, "").replace(/\/\.git$/, "");
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts : [r.name ?? r.id];
}

// Per-repo display label: the *minimal* unique path suffix across the repos shown,
// so two checkouts sharing a basename disambiguate to the fewest stems
// (…/ddd/ccc, …/fff/ccc -> "ddd/ccc", "fff/ccc"; a unique basename stays "ccc").
// Pure + derived from the repo set, so the caller memoizes it.
function computeRepoLabels(repos: RepoRecord[]): Map<string, string> {
  const segs = new Map(repos.map((r) => [r.id, repoSegments(r)] as const));
  const suffix = (id: string, k: number) => (segs.get(id) ?? []).slice(-k).join("/");
  const labels = new Map<string, string>();
  for (const r of repos) {
    const parts = segs.get(r.id) ?? [];
    let k = 1;
    while (
      k < parts.length &&
      repos.some((o) => o.id !== r.id && suffix(o.id, k) === suffix(r.id, k))
    )
      k++;
    labels.set(r.id, suffix(r.id, k));
  }
  return labels;
}

// The text a search query matches against: everything shown on the row (title,
// repo, branch, source, session) plus the status word, lowercased once. Missing
// fields fall out as empty strings.
function reviewHaystack(r: Review, repoLabel: string): string {
  return [
    r.title ?? "",
    repoLabel,
    r.worktree?.branch ?? "",
    sourceLabel(r),
    r.meta.session ?? "",
    r.status,
  ]
    .join(" ")
    .toLowerCase();
}

const Sep = () => <span className="text-neutral-300 dark:text-neutral-600">·</span>;

// One review entry: title, then a per-entry sub-label of repo (disambiguated) ·
// branch · source · session. A review whose repo path is missing (the
// clone moved/was deleted) carries the relink/forget recovery affordance
// — the only place it lives, since ReviewView points here for stale content.
function ReviewRow({
  r,
  repoLabel,
  commonDir,
  missing,
  onRelink,
  onForget,
}: {
  r: Review;
  repoLabel: string;
  commonDir?: string;
  missing: boolean;
  onRelink?: () => void;
  onForget?: () => void;
}) {
  const branch = r.worktree?.branch;
  // An unsaved, browser-only draft on this review (drafts.ts) — surface it here
  // so it isn't forgotten while you work in another review.
  const hasDraft = useHasDraft(r.id);
  return (
    <div className="group rounded-md transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/60">
      {/* A real anchor (not a button): middle-click / ⌘-click open the review in a
          new tab natively, while a plain left-click stays in-app (preventDefault
          + client-side navigate). Modified/aux clicks fall through to the browser. */}
      <a
        href={hrefFor(`/${r.id}`)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          navigate(`/${r.id}`);
        }}
        className="flex w-full flex-col gap-0.5 px-2.5 py-2 text-left"
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              // A live watcher fills the dot solid indigo (matching the panel's
              // "watching" indicator) — the review is ranked to the top and this says
              // why. Without one, an open review is a hollow indigo ring (STATUS_DOT);
              // the terminal states keep their solid color.
              r.watching ? "bg-primary-500" : (STATUS_DOT[r.status] ?? "bg-neutral-400"),
            )}
            title={r.watching ? "an agent is watching" : `status: ${r.status}`}
          />
          <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {r.title || sourceLabel(r)}
          </span>
          {hasDraft && (
            <span
              className="ml-auto shrink-0 text-[0.6875rem] text-warning-500"
              title="Unsaved draft feedback"
            >
              ✎
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 pl-3 text-[0.6875rem] text-neutral-500 dark:text-neutral-400">
          <span
            className={cn(
              // Don't let the project name get squeezed by the branch/session
              // (which share this row and truncate) — show it in full, capped
              // only so a pathologically long disambiguated path still fits.
              "max-w-[60%] shrink-0 truncate font-medium",
              missing
                ? "text-warning-600 dark:text-warning-400"
                : "text-neutral-600 dark:text-neutral-300",
            )}
            title={missing ? `${commonDir ?? repoLabel} — path missing` : commonDir}
          >
            {repoLabel}
            {missing && " ⚠"}
          </span>
          {branch && (
            <>
              <Sep />
              <span className="min-w-0 truncate font-mono" title={`branch: ${branch}`}>
                ⎇ {branch}
              </span>
            </>
          )}
          <Sep />
          <span className="shrink-0">{sourceLabel(r)}</span>
          {r.meta.session && (
            <>
              <Sep />
              <span className="min-w-0 truncate italic" title={`session: ${r.meta.session}`}>
                {r.meta.session}
              </span>
            </>
          )}
        </div>
      </a>
      {missing && (
        <div className="flex items-center gap-2 px-2.5 pb-2 pl-3 text-[0.6875rem]">
          <button
            type="button"
            onClick={onRelink}
            className="text-warning-600 hover:underline dark:text-warning-400"
          >
            relink
          </button>
          <button
            type="button"
            onClick={onForget}
            className="text-neutral-400 hover:text-danger-500"
          >
            forget
          </button>
        </div>
      )}
    </div>
  );
}

function useRepoMutations() {
  const qc = useQueryClient();
  const onDone = () => {
    qc.invalidateQueries({ queryKey: ["repos"] });
    qc.invalidateQueries({ queryKey: ["reviews"] });
  };
  const relink = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => api.relinkRepo(id, path),
    onSuccess: onDone,
  });
  const forget = useMutation({
    mutationFn: (id: string) => api.forgetRepo(id),
    onSuccess: onDone,
  });
  return { relink, forget };
}

export function Home() {
  const { data: reviews = [], isLoading } = useQuery({
    queryKey: ["reviews"],
    queryFn: () => api.listReviews(),
    // The live `watching` flag drives ranking; a watcher on a review you're not
    // viewing arrives on a review-scoped SSE stream we don't see, so poll as a
    // safety net beyond the watchers-changed event (as FeedbackPanel does).
    refetchInterval: 30000,
    refetchIntervalInBackground: true, // keep ranking fresh while the tab is hidden
  });
  const { data: repos = [] } = useQuery({ queryKey: ["repos"], queryFn: () => api.repos() });
  const { relink, forget } = useRepoMutations();
  const openCount = reviews.filter((r) => r.status === "open").length;
  // Display order: watching > open > approved > abandoned, then most-recent first.
  const ordered = useMemo(() => sortReviews(reviews), [reviews]);

  // Reviews FK repos, so every review's repo_id is in `repos` (it returns all of
  // them). Index for per-row lookup, and labels disambiguated across only the
  // repos that appear in the list — memoized off the stable query data.
  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r] as const)), [repos]);
  const repoLabels = useMemo(() => {
    const shown = new Set(reviews.map((r) => r.repo_id));
    return computeRepoLabels(repos.filter((r) => shown.has(r.id)));
  }, [reviews, repos]);

  // Free-text filter over the ranked list — substring match against everything a
  // row shows (see reviewHaystack), so "main", a session name, or a sha prefix all
  // narrow it. Keeps the rank order; just hides non-matches.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? ordered.filter((r) => reviewHaystack(r, repoLabels.get(r.repo_id) ?? "").includes(q))
        : ordered,
    [ordered, q, repoLabels],
  );
  const doRelink = (repo: RepoRecord) => {
    const path = window.prompt(`New path for "${repo.name ?? repo.id}":`, "");
    if (path) relink.mutate({ id: repo.id, path });
  };
  const doForget = (repo: RepoRecord) => {
    // Forgetting drops the repo and its reviews server-side; clear those reviews'
    // browser-only drafts too, or they'd be orphaned in localStorage (re-hydrated
    // on reload but unreachable, since their rows are gone).
    const affected = reviews.filter((r) => r.repo_id === repo.id);
    if (window.confirm(`Forget "${repo.name ?? repo.id}" and its ${affected.length} review(s)?`)) {
      for (const r of affected) clearDraft(r.id);
      forget.mutate(repo.id);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Reviews
            </h1>
            {reviews.length > 0 && (
              <span className="text-xs text-neutral-400">
                {q
                  ? `${filtered.length} of ${reviews.length}`
                  : `${reviews.length}${openCount ? ` · ${openCount} open` : ""}`}
              </span>
            )}
          </div>
          {reviews.length > 0 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reviews…"
              className="w-56 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-800 placeholder:text-neutral-400 focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          )}
        </div>

        {isLoading && <p className="px-1 py-4 text-sm text-neutral-400">Loading…</p>}
        {!isLoading && reviews.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-400 dark:border-neutral-700">
            <p className="font-medium text-neutral-500 dark:text-neutral-400">No reviews yet</p>
            <p className="mt-1">Create one from the r3 CLI or an agent:</p>
            <code className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              r3 create --working
            </code>
          </div>
        )}

        {!isLoading && reviews.length > 0 && filtered.length === 0 && (
          <p className="px-1 py-4 text-sm text-neutral-400">No reviews match “{query.trim()}”.</p>
        )}

        {/* Flat list; each row is repo- (disambiguated) + branch-labeled. */}
        <div className="flex flex-col gap-0.5">
          {filtered.map((r) => {
            const repo = repoById.get(r.repo_id);
            return (
              <ReviewRow
                key={r.id}
                r={r}
                repoLabel={repoLabels.get(r.repo_id) ?? repo?.name ?? r.repo_id}
                commonDir={repo?.commonDir}
                missing={repo?.present === false}
                onRelink={repo ? () => doRelink(repo) : undefined}
                onForget={repo ? () => doForget(repo) : undefined}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
