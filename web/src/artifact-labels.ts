import type { ArtifactTarget, ArtifactThread } from "../../shared/artifacts.ts";
import { mediaTime, wholeMediaBox } from "../../shared/media-target.ts";
import { type AppMessageKey, t } from "./i18n.ts";

export function representationLabel(kind: string) {
  const labels: Record<string, AppMessageKey> = {
    source: "representationToggle.source",
    rendered: "representationToggle.rendered",
    diff: "home.diff",
    media: "common.media",
  };
  return labels[kind] ? t(labels[kind]) : kind;
}

export function targetLabel(
  target: ArtifactTarget,
  latestVersionSeq?: number | null,
  hideVersion = false,
): string {
  if (target.kind === "artifact") return t("artifactLabels.generalArtifact");
  if (target.kind === "artifact_summary") return t("artifactLabels.retiredArtifactOverview");
  if (target.kind === "version_summary")
    return t("artifactLabels.versionSummary", { version: target.versionSeq });
  const range =
    target.locator && "start" in target.locator
      ? `:${target.locator.start}-${target.locator.end}${"side" in target.locator ? ` (${t(target.locator.side === "old" ? "artifactLabels.old" : "artifactLabels.new")})` : ""}`
      : "";
  const label =
    target.kind === "media"
      ? `${target.path}${target.locator.time === null ? "" : ` · ${mediaTime(target.locator.time)}`} · ${t(wholeMediaBox(target.locator.box) ? "artifactLabels.fullFrame" : "artifactLabels.region")}`
      : `${representationLabel(target.kind)} · ${target.path}${range}`;
  if (hideVersion)
    return target.kind === "media"
      ? label
      : target.kind === "rendered" && target.locator?.label
        ? target.locator.label
        : `${target.path}${range}`;
  return target.versionSeq === latestVersionSeq && target.kind !== "media"
    ? `${target.path}${range}`
    : t("artifactLabels.version", { version: target.versionSeq, target: label });
}

export function hasHistoricalTarget(thread: ArtifactThread): boolean {
  const source = thread.comments[0]?.legacy?.source as { file?: unknown } | undefined;
  return (
    thread.target.kind === "artifact" && typeof source?.file === "string" && source.file !== ""
  );
}
export function threadTargetLabel(thread: ArtifactThread): string {
  return hasHistoricalTarget(thread)
    ? t("common.historicalTargetUnavailable")
    : targetLabel(thread.target);
}
