import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, ArtifactState } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { useHasArtifactDraft } from "../artifact-drafts.ts";
import { ArtifactKindIcon } from "../components/ArtifactKindIcon.tsx";
import { formatBytes } from "../format-bytes.ts";
import { hrefFor, navigate } from "../router.ts";

function relativeTime(value: string, now: number): string {
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

function ArtifactRow({
  artifact,
  project,
  now,
}: {
  artifact: Artifact;
  project: string | null;
  now: number;
}) {
  const hasDraft = useHasArtifactDraft(artifact.id);
  const presence = artifact.working
    ? "Agent working"
    : artifact.watching
      ? "Agent listening"
      : null;
  return (
    <a
      href={hrefFor(`/${artifact.id}`)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        navigate(`/${artifact.id}`);
      }}
      className="group flex flex-col gap-1 rounded-md px-3 py-2.5 hover:bg-neutral-100 focus-visible:outline-primary-500 dark:hover:bg-neutral-800"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ArtifactKindIcon kind={artifact.kind} />
        <span className="min-w-0 truncate text-sm font-medium">
          {artifact.title || artifact.id}
        </span>
        {hasDraft && (
          <span className="ml-auto text-xs text-warning-500" title="Draft in this browser">
            ✎
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-3.5 text-xs text-neutral-500 dark:text-neutral-400">
        {project && (
          <span className="max-w-48 truncate font-medium" title={project}>
            {project}
          </span>
        )}
        {artifact.state === "archived" && <span>Archived</span>}
        {artifact.unhandledCount > 0 && (
          <span className="text-primary-600 dark:text-primary-400">
            {artifact.unhandledCount} unhandled
          </span>
        )}
        {presence && <span className="text-primary-600 dark:text-primary-400">{presence}</span>}
        <span
          className="whitespace-nowrap tabular-nums"
          title={`${artifact.storage.totalBytes.toLocaleString()} bytes of published content, counting shared bytes once within this artifact; excludes database overhead`}
        >
          {formatBytes(artifact.storage.totalBytes)} stored
        </span>
        <time
          className="ml-auto"
          dateTime={artifact.updatedAt}
          title={new Date(artifact.updatedAt).toLocaleString()}
        >
          {relativeTime(artifact.updatedAt, now)}
        </time>
      </div>
    </a>
  );
}

export function ArtifactHome() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const artifacts = useQuery({
    queryKey: ["artifacts"],
    queryFn: () => artifactApi.list(),
    refetchInterval: 30_000,
  });
  const projects = useQuery({
    queryKey: ["artifact-projects"],
    queryFn: () => artifactApi.projects(),
  });
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ArtifactState | "all">("all");
  const names = useMemo(
    () => new Map(projects.data?.map((project) => [project.id, project.name ?? project.id])),
    [projects.data],
  );
  const shown = useMemo(() => {
    const search = query.trim().toLowerCase();
    const rank = (artifact: Artifact) =>
      artifact.state === "archived" ? 2 : artifact.watching || artifact.working ? 0 : 1;
    return (artifacts.data ?? [])
      .filter(
        (artifact) =>
          (state === "all" || artifact.state === state) &&
          [
            artifact.id,
            artifact.title,
            artifact.kind,
            artifact.state,
            names.get(artifact.projectId ?? ""),
            ...Object.values(artifact.meta),
            artifact.createdBy.sessionId,
          ]
            .join(" ")
            .toLowerCase()
            .includes(search),
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
  }, [artifacts.data, names, query, state]);
  const error = artifacts.error ?? projects.error;
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3 px-1">
          <h1 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Artifacts
          </h1>
          {artifacts.data && (
            <span className="text-xs text-neutral-500">
              {shown.length} of {artifacts.data.length}
            </span>
          )}
          <div className="ml-auto flex gap-2 max-sm:w-full">
            <select
              aria-label="Artifact state"
              value={state}
              onChange={(event) => setState(event.target.value as ArtifactState | "all")}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs max-md:text-base dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
            <input
              type="search"
              aria-label="Search artifacts"
              placeholder="Search artifacts…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs focus:outline-primary-500 max-sm:flex-1 max-md:text-base dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="px-1 py-2 text-sm text-danger-600">
            {error.message}
          </p>
        )}
        {artifacts.isPending && (
          <p className="px-1 py-4 text-sm text-neutral-500">Loading artifacts…</p>
        )}
        {artifacts.data?.length === 0 && (
          <div className="border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
            <p className="font-medium">No artifacts yet</p>
            <p className="mt-1">Publish a directory from the CLI or an agent:</p>
            <code className="mt-3 inline-block rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">
              r3 create --dir ./artifact
            </code>
          </div>
        )}
        {!!artifacts.data?.length && !shown.length && (
          <p className="px-1 py-4 text-sm text-neutral-500">No artifacts match these filters.</p>
        )}
        <div className="flex flex-col gap-0.5">
          {shown.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              now={now}
              project={
                artifact.projectId ? (names.get(artifact.projectId) ?? artifact.projectId) : null
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
