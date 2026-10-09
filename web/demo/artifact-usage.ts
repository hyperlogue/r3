import {
  type ActivityMetric,
  type ArtifactGcRequest,
  type ArtifactGcResult,
  type ArtifactUsage,
  activityDate,
  DEFAULT_ARCHIVE_TTL_DAYS,
  type UsageWindow,
  usagePeriods,
} from "../../shared/artifact-usage.ts";
import type { ArtifactDemoState } from "./artifact-model.ts";
export interface DemoActivity {
  completeSince: string;
  liveKeys: string[];
  counts: {
    time: string;
    metric: ActivityMetric;
    count: number;
  }[];
}
export function syncDemoActivity(state: ArtifactDemoState): void {
  state.activity ??= {
    completeSince: new Date().toISOString(),
    liveKeys: [],
    counts: [],
  };
  const activity = state.activity;
  const previous = new Set(activity.liveKeys);
  const keys: string[] = [];
  const add = (key: string, time: string, metric: ActivityMetric) => {
    keys.push(key);
    if (previous.has(key)) return;
    const row = activity.counts.find((row) => row.time === time && row.metric === metric);
    if (row) row.count++;
    else activity.counts.push({ time, metric, count: 1 });
  };
  for (const artifact of state.artifacts) {
    add(artifact.id, artifact.createdAt, "artifactsCreated");
    for (const version of artifact.versions)
      add(`${artifact.id}/${version.seq}`, version.publishedAt, "versionsPublished");
    for (const note of artifact.discussions) {
      add(note.id, note.createdAt, "threadsAdded");
      for (const comment of note.comments)
        add(`comment:${comment.id}`, comment.createdAt, "commentsAdded");
    }
    for (const event of artifact.events) {
      add(event.id, event.createdAt, event.event);
      if (event.comment)
        add(`comment:${event.comment.id}`, event.comment.createdAt, "commentsAdded");
    }
  }
  // Only live identities are retained for replay detection; historical counts
  // contain no artifact or message identifiers after deletion.
  activity.liveKeys = keys;
}
function content(state: ArtifactDemoState, ids?: Set<string>): number {
  const all = new Map<string, number>();
  const kept = new Set<string>();
  let patches = 0;
  for (const artifact of state.artifacts) {
    const selected = !ids || ids.has(artifact.id);
    const add = (hash: string, size: number) => {
      all.set(hash, size);
      if (!selected) kept.add(hash);
    };
    for (const version of artifact.versions) {
      const publication = state.publications[`${artifact.id}/${version.seq}`];
      if (!publication) continue;
      if (selected) patches += publication.patchBytes;
      for (const [hash, size] of Object.entries(publication.storageBlobs)) add(hash, size);
    }
    for (const note of artifact.discussions)
      for (const message of note.comments)
        for (const image of message.attachments ?? []) add(image.hash, image.byteLength);
  }
  return (
    patches + [...all].reduce((total, [hash, bytes]) => total + (kept.has(hash) ? 0 : bytes), 0)
  );
}
export function demoGcPreview(
  state: ArtifactDemoState,
  input: ArtifactGcRequest,
  asOf: string,
): ArtifactGcResult {
  const ttlDays = input.ttlDays ?? DEFAULT_ARCHIVE_TTL_DAYS;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 36500)
    throw new Error("Invalid archive TTL");
  const cutoff = new Date(Date.parse(asOf) - ttlDays * 86400000).toISOString();
  const candidates = state.artifacts
    .filter(
      (artifact) =>
        artifact.state === "archived" &&
        artifact.archivedAt! <= cutoff &&
        (!input.candidates ||
          input.candidates.some(
            (row) => row.id === artifact.id && row.archivedAt === artifact.archivedAt,
          )),
    )
    .map(({ id, title, archivedAt }) => ({ id, title, archivedAt: archivedAt! }));
  const ids = new Set(candidates.map((row) => row.id));
  return {
    dryRun: input.dryRun === true,
    ttlDays,
    cutoff,
    candidates,
    reclaimableBytes: content(state, ids),
    deletedIds: [],
    skippedIds: input.candidates?.filter((row) => !ids.has(row.id)).map((row) => row.id) ?? [],
    failures: [],
  };
}
export function demoUsage(
  state: ArtifactDemoState,
  window: UsageWindow,
  asOf: string,
): ArtifactUsage {
  syncDemoActivity(state);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const completeSince = state.activity!.completeSince;
  const periods = usagePeriods(asOf, timezone, window, completeSince);
  for (const row of state.activity!.counts) {
    if (row.time > asOf) continue;
    const date = activityDate(row.time, timezone);
    const period = periods.find((p) => p.start <= date && date < p.end);
    if (period) period[row.metric] += row.count;
  }
  const items = state.artifacts,
    notes = items.flatMap((artifact) => artifact.discussions);
  const gc = demoGcPreview(state, { dryRun: true }, asOf);
  return {
    asOf,
    timezone,
    window,
    completeSince,
    periods,
    artifacts: {
      total: items.length,
      active: items.filter((a) => a.state === "active").length,
      archived: items.filter((a) => a.state === "archived").length,
      files: items.filter((a) => a.kind === "files").length,
      html: items.filter((a) => a.kind === "html").length,
      diff: items.filter((a) => a.kind === "diff").length,
    },
    versions: items.reduce((total, artifact) => total + artifact.versions.length, 0),
    conversations: {
      open: notes.filter((n) => n.status === "open").length,
      resolved: notes.filter((n) => n.status === "resolved").length,
      comments:
        notes.reduce((total, note) => total + note.comments.length, 0) +
        state.artifacts.reduce(
          (total, artifact) => total + artifact.events.filter((event) => event.comment).length,
          0,
        ),
    },
    contentBytes: content(state),
    gc: {
      ttlDays: gc.ttlDays,
      eligibleArtifacts: gc.candidates.length,
      reclaimableBytes: gc.reclaimableBytes,
    },
  };
}
