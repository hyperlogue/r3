import type { ArtifactSearchMatch, ArtifactSearchOptions } from "../../shared/artifact-search.ts";
import type { Artifact, ArtifactKind } from "../../shared/artifacts.ts";

export interface ArtifactLibraryState {
  q: string;
  view: "all" | "attention" | "active" | "archived";
  project: string;
  kind: ArtifactKind | "all";
  history: "latest" | "all";
  type: "all" | "content" | "conversation";
  sort: "attention" | "recent" | "title";
  offset: number;
}
export const libraryDefaults: ArtifactLibraryState = {
  q: "",
  view: "all",
  project: "",
  kind: "all",
  history: "latest",
  type: "all",
  sort: "recent",
  offset: 0,
};
export function readLibraryState(search: string): ArtifactLibraryState {
  const params = new URLSearchParams(search);
  const choice = <T extends string>(key: string, values: T[], fallback: T): T => {
    const value = params.get(key) as T;
    return values.includes(value) ? value : fallback;
  };
  const rawOffset = params.get("offset") ?? "0";
  return {
    q: (params.get("q") ?? "").slice(0, 256),
    view: choice("view", ["all", "attention", "active", "archived"], "all"),
    project: (params.get("project") ?? "").slice(0, 200),
    kind: choice("kind", ["all", "files", "html", "diff"], "all"),
    history: choice("history", ["latest", "all"], "latest"),
    type: choice("type", ["all", "content", "conversation"], "all"),
    sort: choice("sort", ["attention", "recent", "title"], libraryDefaults.sort),
    offset: /^\d+$/.test(rawOffset) && Number(rawOffset) <= 100_000 ? Number(rawOffset) : 0,
  };
}
export function librarySearch(state: ArtifactLibraryState): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state))
    if (value !== libraryDefaults[key as keyof ArtifactLibraryState])
      params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export function librarySearchOptions(state: ArtifactLibraryState): ArtifactSearchOptions {
  return {
    q: state.q.trim(),
    history: state.history,
    type: state.type,
    offset: state.offset,
    kind: state.kind === "all" ? undefined : state.kind,
    project: state.project || undefined,
    attention: state.view === "attention",
    state: state.view === "active" || state.view === "archived" ? state.view : undefined,
  };
}
export function filterLibrary(artifacts: Artifact[], state: ArtifactLibraryState): Artifact[] {
  const rank = (artifact: Artifact) =>
    artifact.state === "archived"
      ? 3
      : artifact.unhandledCount
        ? 0
        : artifact.working || artifact.watching
          ? 1
          : 2;
  return artifacts
    .filter(
      (artifact) =>
        (!state.project || artifact.projectId === state.project) &&
        (state.kind === "all" || artifact.kind === state.kind) &&
        (state.view === "all" ||
          (state.view === "attention"
            ? artifact.state === "active" && artifact.unhandledCount > 0
            : artifact.state === state.view)),
    )
    .sort(
      (a, b) =>
        (state.sort === "title"
          ? (a.title ?? a.id).localeCompare(b.title ?? b.id)
          : state.sort === "attention"
            ? rank(a) - rank(b)
            : 0) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}
export function artifactLibraryRoute(
  artifact: Artifact,
  state: ArtifactLibraryState,
  match?: ArtifactSearchMatch,
): string {
  const params = new URLSearchParams();
  params.set("library", librarySearch(state));
  if (match) {
    if (match.versionSeq !== null) params.set("version", String(match.versionSeq));
    if (match.path) params.set("file", match.path);
    const representation = match.target?.kind ?? match.context.representation;
    if (representation) params.set("view", representation);
    if (match.threadId) params.set("thread", match.threadId);
    if (match.commentId) params.set("comment", match.commentId);
    if (match.category === "summary") params.set("summary", "1");
    if (match.category === "content" && match.target?.locator) {
      const target = match.target;
      if (target.kind === "rendered") params.set("text", target.locator?.quote ?? "");
      else if (target.kind !== "media") {
        params.set("line", String(target.locator!.start));
        if (target.kind === "diff") params.set("side", target.locator!.side);
      }
    }
  }
  return `/${artifact.id}?${params}`;
}
export function libraryReturnRoute(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.has("library")
    ? `/${librarySearch(readLibraryState(params.get("library") ?? ""))}`
    : null;
}

const scrollPositions = new Map<string, number>();
export function rememberLibraryScroll(search: string, top: number): void {
  scrollPositions.delete(search);
  scrollPositions.set(search, top);
  if (scrollPositions.size > 30) scrollPositions.delete(scrollPositions.keys().next().value!);
}
export const libraryScroll = (search: string): number => scrollPositions.get(search) ?? 0;
