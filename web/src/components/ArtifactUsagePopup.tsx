import { useQuery } from "@tanstack/react-query";
import { type RefObject, useRef, useState } from "react";
import {
  ACTIVITY_METRICS,
  type ArtifactUsage,
  type UsageWindow,
} from "../../../shared/artifact-usage.ts";
import { artifactApi } from "../artifact-api.ts";
import { formatBytes } from "../format-bytes.ts";
import { Button, StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";

export function ArtifactUsagePanel({ stats }: { stats: ArtifactUsage }) {
  const a = stats.artifacts,
    c = stats.conversations;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 text-xs sm:grid-cols-3">
        {[
          ["Artifacts", a.total, `${a.active} active · ${a.archived} archived`],
          ["Kinds", `${a.files} / ${a.html} / ${a.diff}`, "Files / HTML / diff"],
          ["Published versions", stats.versions, "All retained publications"],
          ["Conversations", `${c.open} open`, `${c.resolved} resolved · ${c.replies} replies`],
          ["Content size", formatBytes(stats.contentBytes), "Shared bytes counted once"],
          [
            "Ready for cleanup",
            stats.gc.eligibleArtifacts,
            `${formatBytes(stats.gc.reclaimableBytes)} reclaimable · ${stats.gc.ttlDays}-day TTL`,
          ],
        ].map(([label, value, hint]) => (
          <div key={label}>
            <dt className="text-neutral-500">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
            <dd className="mt-0.5 text-[0.65rem] text-neutral-500">{hint}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-neutral-200 px-4 py-2 text-xs dark:border-neutral-800">
        Activity · {stats.timezone} <span className="text-neutral-500">(server timezone)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
          <thead className="bg-neutral-50 text-[0.65rem] text-neutral-500 dark:bg-neutral-900">
            <tr>
              {[
                stats.window === "daily" ? "Day" : "Week of",
                "Created",
                "Published",
                "Threads",
                "Replies",
                "Archived",
                "Restored",
              ].map((label, i) => (
                <th
                  key={label}
                  scope="col"
                  className={`px-3 py-2 font-medium ${i === 0 ? "text-left" : ""}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.periods.map((period) => (
              <tr
                key={period.start}
                className="border-t border-neutral-100 dark:border-neutral-900"
              >
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  {period.start}
                  {period.partial && <span className="ml-1 text-neutral-500">· partial</span>}
                  {period.incompleteHistory && (
                    <span title="Incomplete historical coverage"> *</span>
                  )}
                </th>
                {ACTIVITY_METRICS.map((metric) => (
                  <td key={metric} className="px-3 py-1.5">
                    {period[metric].toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-neutral-200 px-4 py-3 text-[0.65rem] leading-relaxed text-neutral-500 dark:border-neutral-800">
        Totals above describe the current library. Activity remains after deletion. Content size
        excludes disk overhead.
        {stats.completeSince &&
          ` * Earlier history covers surviving records only. Complete tracking since ${new Date(stats.completeSince).toLocaleString(undefined, { timeZone: stats.timezone })} (${stats.timezone}).`}
      </p>
    </>
  );
}
function UsageDialog({
  trigger,
  onClose,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState<UsageWindow>("daily");
  usePopoverFocus(true, popup, trigger);
  useEscape(true, onClose);
  const query = useQuery({
    queryKey: ["artifact-usage", window],
    queryFn: () => artifactApi.stat(window),
    refetchInterval: 60_000,
  });
  return (
    <>
      <button
        type="button"
        aria-label="Close usage statistics"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        ref={popup}
        role="dialog"
        aria-label="Usage statistics"
        className="absolute right-4 top-full z-50 mt-1.5 max-h-[calc(100dvh-5rem)] w-[46rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-neutral-300 bg-white text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Usage statistics</h2>
          <fieldset className="flex gap-1" aria-label="Activity window">
            <Button
              aria-pressed={window === "daily"}
              variant={window === "daily" ? "primary" : "ghost"}
              onClick={() => setWindow("daily")}
            >
              Last 14 days
            </Button>
            <Button
              aria-pressed={window === "weekly"}
              variant={window === "weekly" ? "primary" : "ghost"}
              onClick={() => setWindow("weekly")}
            >
              Last 4 weeks
            </Button>
            <Button aria-label="Close statistics" variant="ghost" onClick={onClose}>
              ×
            </Button>
          </fieldset>
        </div>
        {query.isPending && (
          <p role="status" className="p-4 text-sm">
            Loading usage…
          </p>
        )}
        {query.error && (
          <div role="alert" className="p-4 text-sm text-danger-600">
            Could not load usage. <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        )}
        {query.data && <ArtifactUsagePanel stats={query.data} />}
      </div>
    </>
  );
}
export function ArtifactUsagePopup() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        title="Usage statistics"
        aria-label="Usage statistics"
        aria-haspopup="dialog"
        aria-expanded={open}
        variant="nav"
        className="size-7 justify-center p-0! max-md:size-9"
        onClick={() => setOpen(!open)}
      >
        <StrokeIcon className="size-4">
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </StrokeIcon>
      </Button>
      {open && <UsageDialog trigger={trigger} onClose={() => setOpen(false)} />}
    </>
  );
}
