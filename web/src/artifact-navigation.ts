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
  return requested === "rendered" ? "rendered" : "source";
}

export interface ArtifactLocation extends ArtifactViewSelection {
  feedbackId: string | null;
}

export function readArtifactLocation(kind: ArtifactKind, search: string): ArtifactLocation {
  const params = new URLSearchParams(search);
  const seq = params.get("version");
  return {
    versionSeq:
      seq && /^[1-9]\d*$/.test(seq) && Number.isSafeInteger(Number(seq)) ? Number(seq) : null,
    path: params.get("file") || null,
    representation: artifactRepresentation(
      kind,
      params.get("view") ?? defaultFileRepresentation(params.get("file") ?? ""),
    ),
    feedbackId: params.get("feedback") || null,
  };
}

export function artifactLocationSearch(
  view: ArtifactViewSelection,
  feedbackId?: string | null,
): string {
  const params = new URLSearchParams();
  if (view.versionSeq !== null) params.set("version", String(view.versionSeq));
  if (view.path) params.set("file", view.path);
  params.set("view", view.representation);
  if (feedbackId) params.set("feedback", feedbackId);
  return `?${params}`;
}

// Keep a search entry reproducible on reload until the reader changes its view.
// The library return state survives subsequent navigation inside the artifact.
export function artifactWorkspaceSearch(view: ArtifactLocation, previousSearch: string): string {
  const params = new URLSearchParams(artifactLocationSearch(view, view.feedbackId));
  const previous = new URLSearchParams(previousSearch);
  if (previous.has("library")) params.set("library", previous.get("library")!);
  if (
    ["version", "file", "feedback"].every((key) => params.get(key) === previous.get(key)) &&
    (!previous.has("view") || params.get("view") === previous.get("view"))
  ) {
    for (const key of ["line", "side", "text", "summary", "reply"])
      if (previous.has(key)) params.set(key, previous.get(key)!);
  }
  return `?${params}`;
}

export function isArtifactDocumentTarget(target: ArtifactTarget): target is ArtifactDocumentTarget {
  return target.kind === "source" || target.kind === "rendered" || target.kind === "diff";
}

// Only explicit native targets appear in a representation. A thread's original
// target is never inferred from a line/quote in the other representation.
export function visibleArtifactTargets(
  detail: ArtifactDetail,
  seq: number,
  representation: Representation,
): { feedbackId: string; target: ArtifactDocumentTarget }[] {
  return detail.feedback.flatMap((feedback) => {
    const original = feedback.target;
    if (
      isArtifactDocumentTarget(original) &&
      original.versionSeq === seq &&
      original.kind === representation
    )
      return [{ feedbackId: feedback.id, target: original }];
    return detail.placements
      .filter(
        (placement) =>
          placement.feedbackId === feedback.id &&
          placement.state === "anchored" &&
          placement.target.versionSeq === seq &&
          placement.target.kind === representation,
      )
      .map((placement) => ({ feedbackId: feedback.id, target: placement.target }));
  });
}

export function artifactRegions(
  detail: ArtifactDetail,
  seq: number,
  representation: Representation,
): Region[] {
  const open = new Set(
    detail.feedback.filter((feedback) => feedback.status === "open").map((feedback) => feedback.id),
  );
  return visibleArtifactTargets(detail, seq, representation).flatMap(({ feedbackId, target }) => {
    if (!open.has(feedbackId) || target.kind === "rendered" || !target.locator) return [];
    return [
      {
        id: feedbackId,
        file: target.path,
        start: target.locator.start,
        end: target.locator.end,
        quote: target.locator.quote,
        side: target.kind === "diff" ? target.locator.side : "new",
      },
    ];
  });
}
