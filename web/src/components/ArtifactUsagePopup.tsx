import { useQuery } from "@tanstack/react-query";
import { type RefObject, useRef, useState } from "react";
import {
  ACTIVITY_METRICS,
  type ArtifactUsage,
  type UsageWindow,
} from "../../../shared/artifact-usage.ts";
import { artifactApi } from "../artifact-api.ts";
import { formatBytes } from "../format-bytes.ts";
import { getLanguageTag, useTranslation } from "../i18n.ts";

import { Button, StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";
import { HeaderIconButton } from "./WorkspaceHeader.tsx";

export function ArtifactUsagePanel({ stats }: { stats: ArtifactUsage }) {
  const { t } = useTranslation();
  const a = stats.artifacts,
    c = stats.conversations;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 text-xs sm:grid-cols-3">
        {[
          [t("common.artifacts"), a.total, `${a.active} active · ${a.archived} archived`],
          [
            t("usagePopup.kinds"),
            `${a.files} / ${a.html} / ${a.diff}`,
            t("usagePopup.filesHtmlDiff"),
          ],
          [t("common.publishedVersions"), stats.versions, t("usagePopup.allRetainedPublications")],
          [
            t("common.conversations"),
            `${c.open} open`,
            `${c.resolved} resolved · ${c.comments} comments`,
          ],
          [
            t("usagePopup.contentSize"),
            formatBytes(stats.contentBytes),
            t("usagePopup.sharedBytesCountedOnce"),
          ],
          [
            t("usagePopup.readyForCleanup"),
            stats.gc.eligibleArtifacts,
            t("usagePopup.reclaimableDayTtl", {
              formatBytes_stats_gc_reclaimableBytes: formatBytes(stats.gc.reclaimableBytes),
              stats_gc_ttlDays: stats.gc.ttlDays,
            }),
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
        {t("usagePopup.activity")}
        {stats.timezone} <span className="text-neutral-500">{t("usagePopup.serverTimezone")}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
          <thead className="bg-neutral-50 text-[0.65rem] text-neutral-500 dark:bg-neutral-900">
            <tr>
              {[
                stats.window === "daily" ? t("usagePopup.day") : t("usagePopup.weekOf"),
                t("usagePopup.created"),
                t("usagePopup.published"),
                t("usagePopup.threads"),
                t("usagePopup.comments"),
                t("common.archived"),
                t("common.restored"),
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
                  {period.partial && (
                    <span className="ml-1 text-neutral-500">{t("usagePopup.partial")}</span>
                  )}
                  {period.incompleteHistory && (
                    <span title={t("usagePopup.incompleteHistoricalCoverage")}> *</span>
                  )}
                </th>
                {ACTIVITY_METRICS.map((metric) => (
                  <td key={metric} className="px-3 py-1.5">
                    {period[metric].toLocaleString(getLanguageTag())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-neutral-200 px-4 py-3 text-[0.65rem] leading-relaxed text-neutral-500 dark:border-neutral-800">
        {t("common.totalsAboveDescribeTheCurrentLibraryActivity", {
          stats_completeSince_t_Earlier_history_co:
            stats.completeSince &&
            t("usagePopup.earlierHistoryCoversSurvivingRecordsOnlyComplete", {
              new_Date_stats_completeSince_toLocaleString_u: new Date(
                stats.completeSince,
              ).toLocaleString(getLanguageTag(), { timeZone: stats.timezone }),
              stats_timezone: stats.timezone,
            }),
        })}
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
  const { t } = useTranslation();
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
        aria-label={t("usagePopup.closeUsageStatistics")}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        ref={popup}
        role="dialog"
        aria-label={t("usagePopup.usageStatistics")}
        className="absolute right-4 top-full z-50 mt-1.5 max-h-[calc(100dvh-5rem)] w-[46rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-neutral-300 bg-white text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">{t("usagePopup.usageStatistics")}</h2>
          <fieldset className="flex gap-1" aria-label={t("usagePopup.activityWindow")}>
            <Button
              aria-pressed={window === "daily"}
              variant={window === "daily" ? "primary" : "ghost"}
              onClick={() => setWindow("daily")}
            >
              {t("usagePopup.last14Days")}
            </Button>
            <Button
              aria-pressed={window === "weekly"}
              variant={window === "weekly" ? "primary" : "ghost"}
              onClick={() => setWindow("weekly")}
            >
              {t("usagePopup.last4Weeks")}
            </Button>
            <Button aria-label={t("usagePopup.closeStatistics")} variant="ghost" onClick={onClose}>
              ×
            </Button>
          </fieldset>
        </div>
        {query.isPending && (
          <p role="status" className="p-4 text-sm">
            {t("usagePopup.loadingUsage")}
          </p>
        )}
        {query.error && (
          <div role="alert" className="p-4 text-sm text-danger-600">
            {t("usagePopup.couldNotLoadUsage")}
            <Button onClick={() => void query.refetch()}>{t("common.retry")}</Button>
          </div>
        )}
        {query.data && <ArtifactUsagePanel stats={query.data} />}
      </div>
    </>
  );
}
export function ArtifactUsagePopup() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <HeaderIconButton
        ref={trigger}
        title={t("usagePopup.usageStatistics")}
        aria-label={t("usagePopup.usageStatistics")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <StrokeIcon className="size-4">
          <path d="M5 20V10M12 20V4M19 20v-7M3 20h18" />
        </StrokeIcon>
      </HeaderIconButton>
      {open && <UsageDialog trigger={trigger} onClose={() => setOpen(false)} />}
    </>
  );
}
