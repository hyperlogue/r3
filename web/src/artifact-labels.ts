import type { ArtifactTarget, ArtifactThread } from "../../shared/artifacts.ts";
import { mediaTime, wholeMediaBox } from "../../shared/media-target.ts";
import { t } from "./i18n.ts";

export function representationLabel(kind: string) {
  return t({ source: "Source", rendered: "Rendered", diff: "Diff", media: "Media" }[kind] ?? kind);
}

export function targetLabel(target: ArtifactTarget, latestVersionSeq?: number | null): string {
  if (target.kind === "artifact") return t("General artifact");
  if (target.kind === "artifact_summary") return t("Retired artifact overview");
  if (target.kind === "version_summary")
    return t("Version {version} summary", { version: target.versionSeq });
  const range =
    target.locator && "start" in target.locator
      ? `:${target.locator.start}-${target.locator.end}${"side" in target.locator ? ` (${t(target.locator.side === "old" ? "old" : "new")})` : ""}`
      : "";
  const label =
    target.kind === "media"
      ? `${target.path}${target.locator.time === null ? "" : ` · ${mediaTime(target.locator.time)}`} · ${t(wholeMediaBox(target.locator.box) ? "Full frame" : "Region")}`
      : `${representationLabel(target.kind)} · ${target.path}${range}`;
  return target.versionSeq === latestVersionSeq && target.kind !== "media"
    ? `${target.path}${range}`
    : t("Version {version} · {target}", { version: target.versionSeq, target: label });
}

export function hasHistoricalTarget(thread: ArtifactThread): boolean {
  const source = thread.comments[0]?.legacy?.source as { file?: unknown } | undefined;
  return (
    thread.target.kind === "artifact" && typeof source?.file === "string" && source.file !== ""
  );
}
export function threadTargetLabel(thread: ArtifactThread): string {
  return hasHistoricalTarget(thread)
    ? t("Historical target unavailable")
    : targetLabel(thread.target);
}
