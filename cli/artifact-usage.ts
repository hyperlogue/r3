import {
  ACTIVITY_METRICS,
  type ArtifactGcResult,
  type ArtifactUsage,
} from "../shared/artifact-usage.ts";
import { formatBytes as bytes } from "../shared/format-bytes.ts";
import { ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";
import type { ArtifactCommandContext } from "./artifact-commands.ts";

export async function runUsageCommand(
  command: "stat" | "gc",
  argv: string[],
  ctx: ArtifactCommandContext,
): Promise<number> {
  const args = new ArtifactArgs(argv);
  args.allow(command === "stat" ? ["weekly"] : ["ttl", "dry-run"]);
  if (args.positional.length)
    throw new ArtifactCommandError(`${command} takes no positional arguments`);
  if (command === "stat") {
    const stats = await ctx.client.json<ArtifactUsage>(
      "GET",
      `/api/stat?window=${args.has("weekly") ? "weekly" : "daily"}`,
    );
    if (args.has("json")) await ctx.write(`${JSON.stringify(stats, null, 2)}\n`);
    else {
      const a = stats.artifacts,
        c = stats.conversations;
      const lines = [
        `Usage · ${stats.timezone} · as of ${stats.asOf}`,
        `Artifacts: ${a.total} (${a.active} active, ${a.archived} archived; ${a.files} files, ${a.html} HTML, ${a.diff} diff)`,
        `Published versions: ${stats.versions}`,
        `Conversations: ${c.open} open, ${c.resolved} resolved, ${c.comments} comments`,
        `Content: ${bytes(stats.contentBytes)} (deduplicated; excludes disk overhead)`,
        `Cleanup: ${stats.gc.eligibleArtifacts} eligible · ${bytes(stats.gc.reclaimableBytes)} reclaimable content · TTL ${stats.gc.ttlDays} days`,
        "",
        `${stats.window === "daily" ? "Last 14 days" : "Last 4 weeks"} · ${stats.timezone}`,
        "Period       Created  Published  Threads  Comments  Archived  Restored",
        ...stats.periods.map(
          (period) =>
            `${period.start}  ${ACTIVITY_METRICS.map((metric) => String(period[metric]).padStart(7)).join("  ")}${period.partial ? "  (in progress)" : ""}${period.incompleteHistory ? "  [partial history]" : ""}`,
        ),
      ];
      if (stats.completeSince)
        lines.push(
          `Complete activity tracking since ${stats.completeSince}; earlier counts cover surviving records only.`,
        );
      await ctx.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  const raw = args.value("ttl");
  if (raw !== undefined && !/^[1-9]\d*d$/.test(raw))
    throw new ArtifactCommandError("--ttl requires a whole number of days, such as 30d");
  const ttlDays = raw === undefined ? undefined : Number(raw.slice(0, -1));
  if (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays > 36500))
    throw new ArtifactCommandError("--ttl must be between 1d and 36500d");
  const result = await ctx.client.json<ArtifactGcResult>("POST", "/api/gc", {
    ttlDays,
    dryRun: args.has("dry-run"),
  });
  if (args.has("json")) await ctx.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const lines = [
      result.dryRun
        ? `${result.candidates.length} artifacts eligible · ${bytes(result.reclaimableBytes)} reclaimable content`
        : `Deleted ${result.deletedIds.length} artifacts · ${result.skippedIds.length} skipped · ${result.failures.length} failed`,
      `TTL: ${result.ttlDays} days · archived on or before ${result.cutoff}`,
    ];
    for (const candidate of result.candidates)
      lines.push(
        `${candidate.id} · ${candidate.title ?? "Untitled"} · archived ${candidate.archivedAt}`,
      );
    for (const failure of result.failures) lines.push(`${failure.id}: ${failure.error}`);
    if (result.cleanupError) lines.push(result.cleanupError);
    await ctx.write(`${lines.join("\n")}\n`);
  }
  return result.failures.length || result.cleanupError ? 1 : 0;
}
