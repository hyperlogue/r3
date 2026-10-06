import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { artifactSearchTerms } from "../../../shared/artifact-search.ts";
import { artifactApi } from "../artifact-api.ts";
import {
  type ArtifactLibraryState,
  artifactLibraryRoute,
  filterLibrary,
  libraryScroll,
  librarySearch,
  librarySearchOptions,
  readLibraryState,
  rememberLibraryScroll,
} from "../artifact-library.ts";
import { ArtifactLibraryRow } from "../components/ArtifactLibraryRow.tsx";
import { StrokeIcon } from "../ui.tsx";

const control =
  "min-h-8 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs focus-visible:outline-primary-500 max-md:min-h-9 max-md:min-w-0 max-md:w-full max-md:text-base dark:border-neutral-700 dark:bg-neutral-950";
const filterControl =
  "min-h-9 min-w-0 rounded-none border-neutral-200 bg-transparent py-2 pl-5 pr-3 text-xs hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 max-md:min-h-11 max-md:w-full max-md:pl-4 max-md:text-base dark:border-neutral-800 dark:hover:bg-neutral-900";
const views = [
  ["all", "All artifacts"],
  ["attention", "Needs you"],
  ["active", "Active"],
  ["archived", "Archived"],
] as const;
function LibraryIcon({ kind }: { kind: string }) {
  return (
    <StrokeIcon className="size-4 shrink-0">
      {kind === "attention" ? (
        <path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5" />
      ) : kind === "archived" ? (
        <path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6" />
      ) : kind === "active" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 3 3 5-6" />
        </>
      ) : (
        <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
      )}
    </StrokeIcon>
  );
}

export function ArtifactHome({ initialSearch }: { initialSearch?: string }) {
  const [state, setState] = useState(() => readLibraryState(initialSearch ?? location.search));
  const [query, setQuery] = useState(state.q);
  const [now, setNow] = useState(Date.now);
  const searchInput = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const artifacts = useQuery({
    queryKey: ["artifacts"],
    queryFn: () => artifactApi.list(),
    refetchInterval: 30_000,
  });
  const projects = useQuery({
    queryKey: ["artifact-projects"],
    queryFn: () => artifactApi.projects(),
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(state.q), 200);
    return () => clearTimeout(timer);
  }, [state.q]);
  useEffect(() => {
    const pop = () => {
      const next = readLibraryState(location.search);
      setState(next);
      setQuery(next.q);
      restored.current = false;
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("r3-navigate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("r3-navigate", pop);
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.altKey ||
        document.querySelector('dialog[open],[role="dialog"],[data-overlay]')
      )
        return;
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,select,[contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  const search = librarySearch(state);
  useEffect(() => {
    if (initialSearch === undefined)
      history.replaceState(history.state, "", `${location.pathname}${search}`);
  }, [search, initialSearch]);
  const searching = !!state.q.trim();
  const validQuery = artifactSearchTerms(query).length > 0;
  const options = useMemo(() => librarySearchOptions({ ...state, q: query }), [state, query]);
  const results = useQuery({
    queryKey: ["artifact-search", options],
    queryFn: ({ signal }) => artifactApi.search(options, signal),
    enabled: searching && validQuery && query === state.q,
  });
  const names = useMemo(
    () => new Map(projects.data?.map((project) => [project.id, project.name ?? project.id])),
    [projects.data],
  );
  const counts = useMemo(
    () => ({
      all: artifacts.data?.length ?? 0,
      attention:
        artifacts.data?.filter((a) => a.state === "active" && a.unhandledCount > 0).length ?? 0,
      active: artifacts.data?.filter((a) => a.state === "active").length ?? 0,
      archived: artifacts.data?.filter((a) => a.state === "archived").length ?? 0,
    }),
    [artifacts.data],
  );
  const shown = useMemo(() => filterLibrary(artifacts.data ?? [], state), [artifacts.data, state]);
  const loading = searching
    ? state.q !== query || (validQuery && results.isPending)
    : artifacts.isPending;
  const searchData = searching && query === state.q && validQuery ? results.data : undefined;
  useEffect(() => {
    if (searchData && state.offset > 0 && state.offset >= searchData.total)
      setState((current) => ({ ...current, offset: 0 }));
  }, [searchData, state.offset]);
  const searchArtifacts = new Map(searchData?.artifacts.map((artifact) => [artifact.id, artifact]));
  const error = artifacts.error ?? projects.error ?? (searching ? results.error : null);
  const count = searching ? (searchData?.total ?? 0) : shown.length;
  useLayoutEffect(() => {
    if (loading || restored.current || !pane.current) return;
    pane.current.scrollTop = libraryScroll(search);
    restored.current = true;
  }, [loading, search]);
  const update = (patch: Partial<ArtifactLibraryState>) => {
    setState((current) => ({ ...current, offset: 0, ...patch }));
    pane.current?.scrollTo({ top: 0 });
  };
  const title = state.project
    ? (names.get(state.project) ?? state.project)
    : state.view === "attention"
      ? "Needs you"
      : state.view === "archived"
        ? "Archived artifacts"
        : state.view === "active"
          ? "Active artifacts"
          : "Artifacts";
  const navClass = (selected: boolean) =>
    `flex w-full min-w-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs ${
      selected
        ? "bg-primary-50 font-medium text-primary-700 dark:bg-primary-950/50 dark:text-primary-300"
        : "text-neutral-600 hover:bg-neutral-200/50 dark:text-neutral-400 dark:hover:bg-neutral-800"
    }`;
  let previousGroup = "";
  const clearFilters = () => update({ view: "all", project: "", kind: "all", type: "all" });
  const remember = () => rememberLibraryScroll(search, pane.current?.scrollTop ?? 0);
  return (
    <div className="flex h-full min-w-0">
      <aside
        aria-label="Library navigation"
        className="flex w-52 shrink-0 flex-col gap-7 overflow-y-auto border-r border-neutral-200 bg-neutral-50 px-3 py-6 max-md:hidden dark:border-neutral-800 dark:bg-neutral-950/40"
      >
        <nav aria-label="Library views">
          <h2 className="mb-3 px-3 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500">
            Library
          </h2>
          {views.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={navClass(state.view === value && !state.project)}
              aria-current={state.view === value && !state.project ? "page" : undefined}
              onClick={() => update({ view: value, project: "" })}
            >
              <LibraryIcon kind={value} />
              <span>{label}</span>
              <span className="ml-auto text-[0.65rem] tabular-nums">{counts[value]}</span>
            </button>
          ))}
        </nav>
        <nav aria-label="Projects">
          <h2 className="mb-3 px-3 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500">
            Projects
          </h2>
          {projects.data?.map((project) => (
            <button
              key={project.id}
              type="button"
              className={navClass(state.project === project.id)}
              aria-current={state.project === project.id ? "page" : undefined}
              onClick={() => update({ project: state.project === project.id ? "" : project.id })}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-neutral-400 dark:bg-neutral-500" />
              <span className="truncate" title={project.name ?? project.id}>
                {project.name ?? project.id}
              </span>
              <span className="ml-auto text-[0.65rem] tabular-nums">
                {artifacts.data?.filter((a) => a.projectId === project.id).length ?? 0}
              </span>
            </button>
          ))}
          {projects.data?.length === 0 && (
            <p className="px-3 text-xs leading-relaxed text-neutral-500">No projects yet</p>
          )}
        </nav>
      </aside>
      <div
        ref={pane}
        data-library-pane
        className="min-w-0 flex-1 overflow-y-auto bg-white [scrollbar-gutter:stable] dark:bg-neutral-950"
      >
        <div className="w-full">
          <div className="border-b border-neutral-200 dark:border-neutral-800">
            <div className="flex items-baseline gap-3 px-5 pb-4 pt-6 max-md:px-4 max-md:pt-5">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-xl font-semibold tracking-tight" title={title}>
                  {title}
                </h1>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {state.view === "attention"
                    ? "Agent replies waiting for your review."
                    : state.view === "archived"
                      ? "Every version and conversation, retained."
                      : "Pick up where the conversation left off."}
                </p>
              </div>
              <span className="shrink-0 text-[0.7rem] text-neutral-500 max-sm:hidden">
                {counts.all} artifacts · {projects.data?.length ?? 0} projects
              </span>
            </div>
            <div className="flex items-center gap-2.5 border-y border-neutral-200 bg-neutral-50 px-5 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary-500 max-md:px-4 dark:border-neutral-800 dark:bg-neutral-900">
              <StrokeIcon className="size-4 shrink-0 text-neutral-400">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </StrokeIcon>
              <input
                ref={searchInput}
                type="search"
                aria-label="Search artifacts, content, and conversations"
                placeholder="Search artifacts, content, and conversations…"
                maxLength={256}
                value={state.q}
                onChange={(event) => update({ q: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    pane.current?.querySelector<HTMLAnchorElement>("[data-library-row]")?.focus();
                  }
                }}
                className="h-11 min-w-0 flex-1 rounded-none bg-transparent text-sm outline-none max-md:text-base"
              />
              {state.q && (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="flex size-8 shrink-0 items-center justify-center text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                  onClick={() => {
                    update({ q: "" });
                    searchInput.current?.focus();
                  }}
                >
                  <StrokeIcon className="size-4">
                    <path d="m6 6 12 12M6 18 18 6" />
                  </StrokeIcon>
                </button>
              )}
              <button
                type="button"
                aria-label="Focus search (Control or Command K)"
                onClick={() => searchInput.current?.focus()}
                className="rounded border border-neutral-300 px-1.5 py-0.5 text-[0.65rem] text-neutral-500 max-md:hidden dark:border-neutral-700"
              >
                <kbd>⌘ / Ctrl K</kbd>
              </button>
            </div>
            <div className="flex flex-wrap items-stretch max-md:grid max-md:grid-cols-2">
              <select
                aria-label="Artifact kind"
                className={`${filterControl} border-r max-md:border-b`}
                value={state.kind}
                onChange={(event) =>
                  update({ kind: event.target.value as ArtifactLibraryState["kind"] })
                }
              >
                <option value="all">All kinds</option>
                <option value="html">HTML</option>
                <option value="files">Files</option>
                <option value="diff">Diff</option>
              </select>
              <select
                aria-label="Library view"
                className={`${filterControl} border-b md:hidden`}
                value={state.view}
                onChange={(event) =>
                  update({ view: event.target.value as ArtifactLibraryState["view"] })
                }
              >
                {views.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Project"
                className={`${filterControl} border-r md:hidden`}
                value={state.project}
                onChange={(event) => update({ project: event.target.value })}
              >
                <option value="">All projects</option>
                {projects.data?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name ?? project.id}
                  </option>
                ))}
              </select>
              {state.project && (
                <button
                  type="button"
                  className="px-5 py-2 text-xs text-neutral-500 hover:text-primary-600 max-md:hidden"
                  onClick={() => update({ project: "" })}
                >
                  Clear project ×
                </button>
              )}
              <div className="flex-1 max-md:hidden" />
              {searching ? (
                <select
                  aria-label="Publications to search"
                  className={`${filterControl} border-l max-md:border-l-0`}
                  value={state.history}
                  onChange={(event) =>
                    update({ history: event.target.value as ArtifactLibraryState["history"] })
                  }
                >
                  <option value="latest">Latest publications</option>
                  <option value="all">Include history</option>
                </select>
              ) : (
                <select
                  aria-label="Sort artifacts"
                  className={`${filterControl} border-l max-md:border-l-0`}
                  value={state.sort}
                  onChange={(event) =>
                    update({ sort: event.target.value as ArtifactLibraryState["sort"] })
                  }
                >
                  <option value="attention">Attention first</option>
                  <option value="recent">Recently updated</option>
                  <option value="title">Title A–Z</option>
                </select>
              )}
            </div>
          </div>
          {searching && (
            <fieldset
              className="flex gap-5 border-b border-neutral-200 px-5 max-md:gap-4 max-md:px-4 dark:border-neutral-800"
              aria-label="Search result types"
            >
              {(
                [
                  ["all", "Everything"],
                  ["content", "Content"],
                  ["conversation", "Conversations"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={state.type === value}
                  onClick={() => update({ type: value })}
                  className={`min-h-10 border-b-2 py-2 text-xs ${state.type === value ? "border-primary-500 font-medium text-primary-600 dark:text-primary-400" : "border-transparent text-neutral-500"}`}
                >
                  {label}
                  <span className="ml-1.5 text-[0.65rem] tabular-nums">
                    {searchData?.counts[value] ?? ""}
                  </span>
                </button>
              ))}
            </fieldset>
          )}
          <div
            role="status"
            className="flex items-center gap-3 px-5 py-3 text-[0.7rem] text-neutral-500 max-md:px-4"
          >
            <span>
              {loading
                ? searching
                  ? "Searching…"
                  : "Loading artifacts…"
                : `${count} ${searching ? (count === 1 ? "match" : "matches") : count === 1 ? "artifact" : "artifacts"}`}
            </span>
            <span className="ml-auto max-sm:hidden">
              {searching
                ? "Open a match at its recorded location"
                : state.sort === "attention"
                  ? "Agent replies surface first"
                  : state.sort === "recent"
                    ? "Newest activity first"
                    : "Sorted alphabetically"}
            </span>
          </div>
          {error && (
            <p role="alert" className="px-5 py-4 text-sm text-danger-600">
              {error.message}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  void artifacts.refetch();
                  void projects.refetch();
                  if (searching) void results.refetch();
                }}
              >
                Try again
              </button>
            </p>
          )}
          {!error && !loading && searching && !validQuery && (
            <p className="px-5 py-8 text-sm text-neutral-500">Enter a word or number to search.</p>
          )}
          {!error && !loading && artifacts.data?.length === 0 && (
            <div className="mx-5 border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
              <p className="font-medium">No artifacts yet</p>
              <p className="mt-1">Publish a directory from the CLI or an agent:</p>
              <code className="mt-3 inline-block rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">
                r3 create --kind files --dir ./artifact
              </code>
            </div>
          )}
          {!error &&
            !loading &&
            !!artifacts.data?.length &&
            !count &&
            (!searching || validQuery) && (
              <div className="px-5 py-12 text-center">
                <h2 className="text-sm font-medium">
                  No {searching ? "matches" : "artifacts"} found
                </h2>
                <p className="mt-2 text-xs text-neutral-500">
                  {searching
                    ? "Try a shorter phrase, another project, or earlier publications."
                    : "Try another project or clear your filters."}
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <button type="button" className={control} onClick={clearFilters}>
                    Clear filters
                  </button>
                  {searching && state.history === "latest" && (
                    <button
                      type="button"
                      className={control}
                      onClick={() => update({ history: "all" })}
                    >
                      Include history
                    </button>
                  )}
                </div>
              </div>
            )}
          <section
            aria-label={searching ? "Search results" : "Artifacts"}
            onKeyDown={(event) => {
              if (
                event.altKey ||
                event.metaKey ||
                event.ctrlKey ||
                !["ArrowDown", "ArrowUp"].includes(event.key)
              )
                return;
              const rows = [
                ...event.currentTarget.querySelectorAll<HTMLAnchorElement>("[data-library-row]"),
              ];
              const index = rows.indexOf(event.target as HTMLAnchorElement);
              if (index < 0) return;
              event.preventDefault();
              rows[
                Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
              ]?.focus();
            }}
          >
            {!searching &&
              shown.map((artifact) => {
                const group =
                  artifact.state === "archived"
                    ? "Archived"
                    : artifact.unhandledCount
                      ? "Needs your review"
                      : artifact.working || artifact.watching
                        ? "In progress"
                        : "Other artifacts";
                const heading = state.sort === "attention" && previousGroup !== group;
                previousGroup = group;
                return (
                  <Fragment key={artifact.id}>
                    {heading && (
                      <h2 className="border-y border-neutral-200 bg-neutral-50 px-5 py-2 text-[0.6rem] font-semibold uppercase tracking-widest text-neutral-500 max-md:px-4 dark:border-neutral-800 dark:bg-neutral-900/60">
                        {group}
                      </h2>
                    )}
                    <ArtifactLibraryRow
                      artifact={artifact}
                      project={names.get(artifact.projectId ?? "") ?? null}
                      now={now}
                      route={artifactLibraryRoute(artifact, state)}
                      onOpen={remember}
                    />
                  </Fragment>
                );
              })}
            {!loading &&
              searchData?.matches.map((match) => {
                const artifact = searchArtifacts.get(match.artifactId);
                return (
                  artifact && (
                    <ArtifactLibraryRow
                      key={match.id}
                      artifact={artifact}
                      match={match}
                      query={query}
                      project={names.get(artifact.projectId ?? "") ?? null}
                      now={now}
                      route={artifactLibraryRoute(artifact, state, match)}
                      onOpen={remember}
                    />
                  )
                );
              })}
          </section>
          {searchData && (state.offset > 0 || searchData.nextOffset !== null) && (
            <nav
              aria-label="Search pages"
              className="flex items-center justify-between gap-4 px-5 py-4"
            >
              <button
                type="button"
                className={control}
                disabled={state.offset === 0}
                onClick={() => update({ offset: Math.max(0, state.offset - 50) })}
              >
                Previous
              </button>
              <span className="text-xs text-neutral-500">
                {state.offset + 1}–{state.offset + searchData.matches.length} of {searchData.total}
              </span>
              <button
                type="button"
                className={control}
                disabled={searchData.nextOffset === null}
                onClick={() => update({ offset: searchData.nextOffset ?? 0 })}
              >
                Next
              </button>
            </nav>
          )}
          {searching && (
            <p className="px-5 py-4 text-[0.65rem] leading-relaxed text-neutral-500 max-md:px-4">
              All words must match; word prefixes are supported. Conversations keep their original
              version context. HTML search covers published page text, without running scripts.
              {searchData?.skippedFiles
                ? ` ${searchData.skippedFiles} binary, invalid UTF-8, or oversized files excluded.`
                : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
