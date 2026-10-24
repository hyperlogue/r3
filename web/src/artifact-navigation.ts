import type {
  ArtifactDetail,
  ArtifactDocumentTarget,
  ArtifactKind,
  ArtifactTarget,
  Representation,
} from "../../shared/artifacts.ts";
import type { ArtifactViewSelection } from "./artifact-version.ts";
import type { Region } from "./highlights.ts";

export function defaultFileRepresentation(path: string): "source" | "rendered" {
  return /\.(md|markdown)$/i.test(path) ? "rendered" : "source";
}

export function artifactRepresentation(
  kind: ArtifactKind,
  requested?: string | null,
): Representation {
  if (kind === "diff") return "diff";
  if (kind === "html") return "rendered";
  return requested === "media" ? "media" : requested === "rendered" ? "rendered" : "source";
}

export interface ArtifactLocation extends ArtifactViewSelection {
  threadId: string | null;
}

export function readArtifactLocation(
  kind: ArtifactKind,
  search: string,
  saved?: ArtifactLocation | null,
): ArtifactLocation {
  const params = new URLSearchParams(search);
  const seq = params.get("version");
  const versionSeq =
    seq && /^[1-9]\d*$/.test(seq) && Number.isSafeInteger(Number(seq)) ? Number(seq) : null;
  const selection = saved?.versionSeq === versionSeq ? saved : null;
  return {
    versionSeq,
    path: selection?.path ?? null,
    representation: artifactRepresentation(
      kind,
      selection?.representation ?? defaultFileRepresentation(selection?.path ?? ""),
    ),
    threadId: selection?.threadId ?? null,
  };
}

export function artifactLocationSearch(view: Pick<ArtifactViewSelection, "versionSeq">): string {
  const params = new URLSearchParams();
  if (view.versionSeq !== null) params.set("version", String(view.versionSeq));
  return params.size ? `?${params}` : "";
}

// Only publication/comparison links and navigation preferences belong in the URL.
// A comparison is tied to the workspace version in which it was opened.
export function artifactWorkspaceSearch(view: ArtifactLocation, previousSearch: string): string {
  const params = new URLSearchParams(artifactLocationSearch(view));
  const previous = new URLSearchParams(previousSearch);
  if (
    previous.get("compare") &&
    (!previous.has("version") || params.get("version") === previous.get("version"))
  )
    params.set("compare", previous.get("compare")!);
  for (const key of ["library", "lang"]) if (previous.has(key)) params.set(key, previous.get(key)!);
  return params.size ? `?${params}` : "";
}

export function isArtifactDocumentTarget(target: ArtifactTarget): target is ArtifactDocumentTarget {
  return (
    target.kind === "media" ||
    target.kind === "source" ||
    target.kind === "rendered" ||
    target.kind === "diff"
  );
}

// Only explicit native targets appear in a representation. A thread's original
// target is never inferred from a line/quote in the other representation.
export function visibleArtifactTargets(
  detail: ArtifactDetail,
  seq: number,
  representation: Representation,
): { threadId: string; target: ArtifactDocumentTarget }[] {
  return detail.threads.flatMap((threads) => {
    const original = threads.target;
    if (
      isArtifactDocumentTarget(original) &&
      original.versionSeq === seq &&
      original.kind === representation
    )
      return [{ threadId: threads.id, target: original }];
    return detail.placements
      .filter(
        (placement) =>
          placement.threadId === threads.id &&
          placement.state === "anchored" &&
          placement.target.versionSeq === seq &&
          placement.target.kind === representation,
      )
      .map((placement) => ({ threadId: threads.id, target: placement.target }));
  });
}

export function artifactRegions(
  detail: ArtifactDetail,
  seq: number,
  representation: Representation,
): Region[] {
  const open = new Set(
    detail.threads.filter((threads) => threads.status === "open").map((threads) => threads.id),
  );
  return visibleArtifactTargets(detail, seq, representation).flatMap(({ threadId, target }) => {
    if (
      !open.has(threadId) ||
      target.kind === "rendered" ||
      target.kind === "media" ||
      !target.locator
    )
      return [];
    return [
      {
        id: threadId,
        file: target.path,
        start: target.locator.start,
        end: target.locator.end,
        quote: target.locator.quote,
        side: target.kind === "diff" ? target.locator.side : "new",
      },
    ];
  });
}
