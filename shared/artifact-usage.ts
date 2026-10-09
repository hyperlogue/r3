export const DEFAULT_ARCHIVE_TTL_DAYS = 30;
export const MAX_ARCHIVE_TTL_DAYS = 36500;
export type UsageWindow = "daily" | "weekly";
export const ACTIVITY_METRICS = [
  "artifactsCreated",
  "versionsPublished",
  "threadsAdded",
  "commentsAdded",
  "archived",
  "restored",
] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];
export type ActivityCounts = Record<ActivityMetric, number>;
export interface UsagePeriod extends ActivityCounts {
  start: string;
  end: string;
  partial: boolean;
  incompleteHistory: boolean;
}
export interface GcCandidate {
  id: string;
  title: string | null;
  archivedAt: string;
}
export interface ArtifactGcRequest {
  ttlDays?: number;
  dryRun?: boolean;
  // A web confirmation may only remove members of the preview it displayed.
  candidates?: Pick<GcCandidate, "id" | "archivedAt">[];
}
export interface ArtifactGcResult {
  dryRun: boolean;
  ttlDays: number;
  cutoff: string;
  candidates: GcCandidate[];
  reclaimableBytes: number;
  deletedIds: string[];
  skippedIds: string[];
  failures: { id: string; error: string }[];
  cleanupError?: string;
}
export interface ArtifactUsage {
  asOf: string;
  timezone: string;
  window: UsageWindow;
  // Null for stores whose activity history has always been complete.
  completeSince: string | null;
  artifacts: {
    total: number;
    active: number;
    archived: number;
    files: number;
    html: number;
    diff: number;
  };
  versions: number;
  conversations: { open: number; resolved: number; comments: number };
  contentBytes: number;
  gc: { ttlDays: number; eligibleArtifacts: number; reclaimableBytes: number };
  periods: UsagePeriod[];
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
export function activityDate(time: string, timezone: string): string {
  let format = dateFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    if (dateFormats.size >= 8) dateFormats.clear();
    dateFormats.set(timezone, format);
  }
  const parts = format.formatToParts(new Date(time));
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function usagePeriods(
  asOf: string,
  timezone: string,
  window: UsageWindow,
  completeSince: string | null,
): UsagePeriod[] {
  const today = activityDate(asOf, timezone);
  const weekly = window === "weekly";
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const last = weekly ? shiftDate(today, -((weekday + 6) % 7)) : today;
  const count = weekly ? 4 : 14;
  const step = weekly ? 7 : 1;
  const coverage = completeSince && activityDate(completeSince, timezone);
  return Array.from({ length: count }, (_, index) => {
    const start = shiftDate(last, -(count - index - 1) * step);
    return {
      start,
      end: shiftDate(start, step),
      partial: index === count - 1,
      incompleteHistory: !!coverage && start <= coverage,
      artifactsCreated: 0,
      versionsPublished: 0,
      threadsAdded: 0,
      commentsAdded: 0,
      archived: 0,
      restored: 0,
    };
  });
}
