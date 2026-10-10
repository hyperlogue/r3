import type { Database } from "bun:sqlite";
import {
  type ActivityMetric,
  type ArtifactGcResult,
  type ArtifactUsage,
  activityDate,
  DEFAULT_ARCHIVE_TTL_DAYS,
  type GcCandidate,
  MAX_ARCHIVE_TTL_DAYS,
  type UsageWindow,
  usagePeriods,
} from "../shared/artifact-usage.ts";
import { ArtifactError, requireObject } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { nowIso } from "./ids.ts";

export function archiveTtlDays(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_ARCHIVE_TTL_DAYS
  )
    throw new ArtifactError(`ttlDays must be an integer from 1 to ${MAX_ARCHIVE_TTL_DAYS}`);
  return value;
}
// Published content and image references share one hash namespace. Patch text
// lives in SQL and counts once per committed version, independently of blobs.
const REFERENCES = `SELECT f.artifact_id, f.blob_hash AS hash FROM version_files f
  JOIN artifact_versions v ON v.artifact_id=f.artifact_id AND v.seq=f.version_seq WHERE v.published_at IS NOT NULL
  UNION SELECT f.artifact_id, f.rendered_blob_hash FROM version_files f
  JOIN artifact_versions v ON v.artifact_id=f.artifact_id AND v.seq=f.version_seq WHERE v.published_at IS NOT NULL AND f.rendered_blob_hash IS NOT NULL
  UNION SELECT artifact_id, blob_hash FROM message_attachments`;

export class ArtifactUsageStore {
  readonly ttlDays: number;
  readonly timezone: string;
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
    private readonly clock: () => string = nowIso,
    ttlDays = DEFAULT_ARCHIVE_TTL_DAYS,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    this.ttlDays = archiveTtlDays(ttlDays);
    // Validate an injected zone at construction, never silently fall back.
    activityDate(clock(), timezone);
    this.timezone = timezone;
  }
  private bytes(ids?: string[]): number {
    return this.db
      .query<{ bytes: number }, [string | null]>(`WITH refs AS (${REFERENCES}),
      selected AS (SELECT value AS id FROM json_each(?1)), sizes AS (
        SELECT byte_length AS bytes FROM blobs b WHERE EXISTS (SELECT 1 FROM refs WHERE hash=b.hash)
        AND (?1 IS NULL OR NOT EXISTS (SELECT 1 FROM refs WHERE hash=b.hash AND artifact_id NOT IN (SELECT id FROM selected)))
        UNION ALL SELECT length(CAST(patch_body AS BLOB)) FROM artifact_versions
        WHERE published_at IS NOT NULL AND patch_body IS NOT NULL
        AND (?1 IS NULL OR artifact_id IN (SELECT id FROM selected))
      ) SELECT COALESCE(sum(bytes),0) AS bytes FROM sizes`)
      .get(ids ? JSON.stringify(ids) : null)!.bytes;
  }
  private candidates(cutoff: string): GcCandidate[] {
    return this.db
      .query<GcCandidate, [string]>(`SELECT id, title, archived_at AS archivedAt FROM artifacts
      WHERE state='archived' AND archived_at <= ? ORDER BY archived_at, id`)
      .all(cutoff);
  }
  stat(window: UsageWindow = "daily"): ArtifactUsage {
    const asOf = this.clock();
    const completeSince = this.db
      .query<{ complete_since: string | null }, []>(
        "SELECT complete_since FROM artifact_activity_coverage WHERE id=1",
      )
      .get()!.complete_since;
    const periods = usagePeriods(asOf, this.timezone, window, completeSince);
    // Even the longest fixed window fits within 35 elapsed days across DST.
    const since = new Date(Date.parse(asOf) - 35 * 86400000).toISOString();
    for (const row of this.db
      .query<{ occurred_at: string; metric: ActivityMetric; count: number }, [string, string]>(
        "SELECT * FROM artifact_activity WHERE occurred_at >= ? AND occurred_at <= ?",
      )
      .all(since, asOf)) {
      const date = activityDate(row.occurred_at, this.timezone);
      const bucket = periods.find((period) => date >= period.start && date < period.end);
      if (bucket) bucket[row.metric] += row.count;
    }
    const artifacts = this.db
      .query<ArtifactUsage["artifacts"], []>(`SELECT count(*) AS total,
      COALESCE(sum(state='active'),0) AS active, COALESCE(sum(state='archived'),0) AS archived,
      COALESCE(sum(kind='files'),0) AS files, COALESCE(sum(kind='html'),0) AS html, COALESCE(sum(kind='diff'),0) AS diff FROM artifacts`)
      .get()!;
    const count = (sql: string) => this.db.query<{ n: number }, []>(sql).get()!.n;
    const gc = this.gc({ dryRun: true });
    return {
      asOf,
      timezone: this.timezone,
      window,
      completeSince,
      artifacts,
      versions: count("SELECT count(*) AS n FROM artifact_versions WHERE published_at IS NOT NULL"),
      conversations: {
        open: count("SELECT count(*) AS n FROM threads WHERE status='open'"),
        resolved: count("SELECT count(*) AS n FROM threads WHERE status='resolved'"),
        comments: count(
          "SELECT (SELECT count(*) FROM comments) + (SELECT count(*) FROM threads) + (SELECT count(*) FROM artifact_comments) AS n",
        ),
      },
      contentBytes: this.bytes(),
      gc: {
        ttlDays: this.ttlDays,
        eligibleArtifacts: gc.candidates.length,
        reclaimableBytes: gc.reclaimableBytes,
      },
      periods,
    };
  }
  gc(value: unknown): ArtifactGcResult {
    const input = requireObject(value, "Garbage collection");
    const ttlDays = input.ttlDays === undefined ? this.ttlDays : archiveTtlDays(input.ttlDays);
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
      throw new ArtifactError("dryRun must be a boolean");
    const cutoff = new Date(Date.parse(this.clock()) - ttlDays * 86400000).toISOString();
    const eligible = this.candidates(cutoff);
    let candidates = eligible;
    const skippedIds: string[] = [];
    if (input.candidates !== undefined) {
      if (!Array.isArray(input.candidates) || input.candidates.length > 10000)
        throw new ArtifactError("candidates must be an array of at most 10000 entries");
      const selected = new Map<string, string>();
      for (const item of input.candidates) {
        const row = requireObject(item, "Candidate");
        if (
          typeof row.id !== "string" ||
          !row.id ||
          row.id.length > 200 ||
          typeof row.archivedAt !== "string" ||
          !Number.isFinite(Date.parse(row.archivedAt)) ||
          selected.has(row.id)
        )
          throw new ArtifactError("Invalid or duplicate GC candidate");
        selected.set(row.id, row.archivedAt);
      }
      candidates = eligible.filter((row) => selected.get(row.id) === row.archivedAt);
      const held = new Set(candidates.map((row) => row.id));
      for (const id of selected.keys()) if (!held.has(id)) skippedIds.push(id);
    }
    const result: ArtifactGcResult = {
      dryRun: input.dryRun === true,
      ttlDays,
      cutoff,
      candidates,
      reclaimableBytes: this.bytes(candidates.map((row) => row.id)),
      deletedIds: [],
      skippedIds,
      failures: [],
    };
    if (!result.dryRun)
      for (const candidate of candidates) {
        // Synchronous selection/deletion on the daemon's sole connection leaves
        // no await where restore or a second archive can race this decision.
        try {
          this.artifacts.delete(candidate.id);
          result.deletedIds.push(candidate.id);
        } catch {
          result.failures.push({ id: candidate.id, error: "Artifact deletion failed" });
        }
      }
    return result;
  }
}
