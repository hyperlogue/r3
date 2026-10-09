import type { ReactNode } from "react";
import type { ArtifactSearchMatch } from "../../../shared/artifact-search.ts";
import { artifactSearchTerms } from "../../../shared/artifact-search.ts";
import type { Artifact } from "../../../shared/artifacts.ts";
import { useHasArtifactDraft } from "../artifact-drafts.ts";
import { formatBytes } from "../format-bytes.ts";
import { hrefFor, navigate } from "../router.ts";
import { StrokeIcon } from "../ui.tsx";
import { ArtifactKindIcon } from "./ArtifactKindIcon.tsx";

export function relativeArtifactTime(value: string, now: number): string {
  const seconds = (Date.parse(value) - now) / 1000;
  if (Math.abs(seconds) < 60) return "just now";
  const [scale, unit] =
    Math.abs(seconds) < 3600
      ? ([60, "minute"] as const)
      : Math.abs(seconds) < 86400
        ? ([3600, "hour"] as const)
        : Math.abs(seconds) < 604800
          ? ([86400, "day"] as const)
          : Math.abs(seconds) < 2592000
            ? ([604800, "week"] as const)
            : Math.abs(seconds) < 31536000
              ? ([2592000, "month"] as const)
              : ([31536000, "year"] as const);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.trunc(seconds / scale),
    unit,
  );
}

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const terms = artifactSearchTerms(query);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!terms.some((term) => match[0].toLowerCase().startsWith(term))) continue;
    parts.push(text.slice(cursor, match.index));
    parts.push(
      <mark
        key={match.index}
        className="rounded-sm bg-warning-100 text-inherit dark:bg-warning-900/50"
      >
        {match[0]}
      </mark>,
    );
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
const matchLabels = {
  artifact: "Artifact",
  summary: "Publication summary",
  content: "Published content",
  discussions: "Discussion",
  comment: "Comment",
};
export function ArtifactLibraryRow({
  artifact,
  project,
  now,
  route,
  onOpen,
  match,
  query = "",
}: {
  artifact: Artifact;
  project: string | null;
  now: number;
  route: string;
  onOpen: () => void;
  match?: ArtifactSearchMatch;
  query?: string;
}) {
  const hasDraft = useHasArtifactDraft(artifact.id);
  const archived = artifact.state === "archived";
  const status = archived
    ? "Archived"
    : artifact.unhandledCount
      ? `${artifact.unhandledCount} to review`
      : artifact.working
        ? "Agent working"
        : artifact.watching
          ? "Agent listening"
          : null;
  const version =
    match && match.category !== "artifact" ? match.versionSeq : artifact.latestVersion?.seq;
  const historical =
    match?.versionSeq != null &&
    artifact.latestVersion != null &&
    match.versionSeq < artifact.latestVersion.seq;
  return (
    <a
      href={hrefFor(route)}
      data-library-row
      onClick={(event) => {
        onOpen();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        navigate(route);
      }}
      className="group flex min-w-0 items-start gap-3 border-b border-neutral-200 px-5 py-2.5 text-inherit no-underline hover:bg-neutral-100/70 focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 max-md:gap-2.5 max-md:px-4 max-md:py-3 dark:border-neutral-800 dark:hover:bg-neutral-800/60"
    >
      <span
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center ${artifact.kind === "html" ? "bg-primary-50 dark:bg-primary-950/30" : "bg-neutral-100 dark:bg-neutral-800"}`}
      >
        <ArtifactKindIcon kind={artifact.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2
            className="truncate text-sm font-medium leading-6"
            title={artifact.title ?? artifact.id}
          >
            <SearchHighlight text={artifact.title ?? artifact.id} query={query} />
          </h2>
          {hasDraft && (
            <span
              className="shrink-0 text-xs text-warning-600 dark:text-warning-400"
              title="Draft in this browser"
              role="img"
              aria-label="Draft in this browser"
            >
              ✎
            </span>
          )}
          {match && (
            <span className="shrink-0 text-[0.65rem] text-neutral-500 max-sm:hidden">
              {matchLabels[match.category]}
            </span>
          )}
        </div>
        {match && match.category !== "artifact" && (
          <p className="line-clamp-2 text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
            <SearchHighlight text={match.snippet} query={query} />
          </p>
        )}
        <div className="flex min-w-0 items-center gap-1.5 text-[0.7rem] leading-5 text-neutral-500 dark:text-neutral-400">
          {project && (
            <>
              <span className="max-w-36 shrink-0 truncate max-md:max-w-20" title={project}>
                {project}
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0">
            {version != null
              ? `v${version}`
              : match && match.category !== "artifact"
                ? "General"
                : "Unpublished"}
          </span>
          {historical && (
            <span className="shrink-0 rounded bg-warning-50 px-1.5 text-[0.6rem] text-warning-700 dark:bg-warning-950/30 dark:text-warning-300">
              Historical
            </span>
          )}
          <span aria-hidden="true">·</span>
          {match?.path ? (
            <span className="truncate font-mono" title={match.path}>
              {match.path}
              {match.target?.kind === "source" && match.target.locator
                ? `:${match.target.locator.start}`
                : match.target?.kind === "diff" && match.target.locator
                  ? ` · ${match.target.locator.side}:${match.target.locator.start}`
                  : ""}
            </span>
          ) : (
            <span className="min-w-0 truncate">
              {match && match.category !== "artifact"
                ? matchLabels[match.category]
                : (artifact.latestVersion?.summary ?? artifact.kind.toUpperCase())}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        {status && (
          <span
            className={`max-w-40 truncate rounded px-1.5 py-0.5 text-[0.65rem] leading-4 ${!archived && artifact.unhandledCount ? "bg-primary-50 font-medium text-primary-700 dark:bg-primary-950/50 dark:text-primary-300" : "text-neutral-500 dark:text-neutral-400"}`}
          >
            {status}
          </span>
        )}
        <div className="flex items-center gap-1.5 whitespace-nowrap text-[0.65rem] leading-5 text-neutral-500 max-lg:flex-col max-lg:items-end max-lg:gap-0 dark:text-neutral-400">
          <span
            className="tabular-nums"
            title={`${artifact.storage.totalBytes.toLocaleString()} bytes of published content, counting shared bytes once within this artifact; excludes database overhead`}
          >
            {formatBytes(artifact.storage.totalBytes)} stored
          </span>
          <span aria-hidden="true" className="max-lg:hidden">
            ·
          </span>
          <time
            dateTime={artifact.updatedAt}
            title={new Date(artifact.updatedAt).toLocaleString()}
            className="max-md:hidden"
          >
            {relativeArtifactTime(artifact.updatedAt, now)}
          </time>
        </div>
      </div>
      <StrokeIcon className="mt-3 size-3.5 shrink-0 text-neutral-400 max-sm:hidden">
        <path d="m9 5 7 7-7 7" />
      </StrokeIcon>
    </a>
  );
}
