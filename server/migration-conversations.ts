import type { ArtifactTarget, ArtifactVersionTarget } from "../shared/artifacts.ts";
import { ArtifactTargets, targetColumns } from "./artifact-targets.ts";
import { ArtifactError } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { parseUnifiedDiff } from "./git.ts";
import {
  type LegacyRow,
  legacyId,
  legacySeq,
  legacyText,
  type MigrationContext,
} from "./migration-data.ts";
import type { MigrationDefaults } from "./migration-defaults.ts";

// Import original targets only when the legacy record establishes their native
// version and representation. A match in current text is not historical proof.
async function originalTarget(
  store: ArtifactStore,
  artifactId: string,
  row: LegacyRow,
  defaults: MigrationDefaults,
  reply = false,
): Promise<ArtifactTarget | null> {
  const file = legacyText(row.file);
  if (!reply && file === "") return { kind: "artifact" };
  const versionSeq = legacySeq(row.patch_seq);
  let candidate: ArtifactTarget | null = null;
  if (!reply && file === "@summary") {
    const locator = row.quote ? { quote: String(row.quote) } : null;
    candidate =
      versionSeq === null
        ? { kind: "artifact_summary", locator }
        : { kind: "version_summary", versionSeq, locator };
  } else if (file && versionSeq !== null && store.get(artifactId).kind === "diff") {
    const start = legacySeq(row.line_start);
    const end = legacySeq(row.line_end);
    const side = reply ? "new" : row.side;
    if (!row.line_start && !row.line_end && !row.quote) {
      candidate = { kind: "diff", versionSeq, path: file, locator: null };
    } else if (start !== null && end !== null && (side === "old" || side === "new")) {
      let quote = legacyText(row.quote);
      if (!quote) {
        try {
          const patchFile = parseUnifiedDiff(store.patch(artifactId, versionSeq)).find(
            (entry) => entry.path === file || entry.oldPath === file,
          );
          quote =
            patchFile?.lines
              .filter((line) => {
                const number = side === "old" ? line.oldLine : line.newLine;
                return number !== null && number >= start && number <= end;
              })
              .map((line) => line.text)
              .join("\n") ?? null;
          if (quote)
            defaults.record(
              "target.quote",
              quote,
              "Derived from the explicit retained patch side and range",
            );
        } catch (error) {
          if (!(error instanceof ArtifactError)) throw error;
        }
      }
      if (quote)
        candidate = { kind: "diff", versionSeq, path: file, locator: { start, end, side, quote } };
    }
  }
  // Retired description targets remain immutable evidence, with no new write API.
  if (candidate?.kind === "artifact_summary") return candidate;
  if (candidate) {
    try {
      if (candidate.kind === "version_summary") {
        store.version(artifactId, candidate.versionSeq);
        return candidate;
      }
      return await new ArtifactTargets(store).target(artifactId, candidate);
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      defaults.record("target", reply ? null : { kind: "artifact" }, error.message);
    }
  } else if (!reply || row.patch_seq || row.file || row.quote) {
    defaults.record(
      "target",
      reply ? null : { kind: "artifact" },
      "Original version or representation cannot be proved; retained the legacy target evidence",
    );
  }
  return reply ? null : { kind: "artifact" };
}

function messageBody(row: LegacyRow): string {
  if (typeof row.body !== "string") throw new Error("Legacy message has no retained text");
  return row.body;
}

function deliveredAt(
  row: LegacyRow,
  role: "human" | "agent",
  createdAt: string,
  defaults: MigrationDefaults,
): string | null {
  if (row.sent_at !== null && row.sent_at !== undefined)
    return defaults.time("sentAt", row.sent_at, createdAt);
  if (role === "human") return null;
  defaults.record("sentAt", createdAt, "Agent-authored messages are born delivered");
  return createdAt;
}

export async function importLegacyConversations(
  context: MigrationContext,
  store: ArtifactStore,
): Promise<void> {
  const { data, db } = context;
  for (const row of data.feedback) {
    const id = legacyId(row.id);
    const artifactId = legacyId(row.review_id);
    const artifact = store.get(artifactId);
    const defaults = context.defaults(`feedback:${id}`);
    const createdAt = defaults.time("createdAt", row.created_at, artifact.createdAt);
    const updatedAt = defaults.time("updatedAt", row.updated_at, createdAt);
    const author = defaults.actor("author", row.author, undefined, createdAt);
    const status =
      row.status === "resolved" ||
      row.status === "refuted" ||
      (row.status === "accepted" && row.sent_at)
        ? "resolved"
        : "open";
    if (status !== row.status)
      defaults.record("status", status, "Mapped the legacy feedback lifecycle");
    const target = targetColumns((await originalTarget(store, artifactId, row, defaults))!);
    const sentAt = deliveredAt(row, author.role, createdAt, defaults);
    const claim = data.feedback_claims.find((claim) => claim.feedback_id === id);
    if (claim)
      defaults.record(
        "claim",
        null,
        "Legacy work leases and transport registrations must be re-established after the protocol upgrade",
      );
    context.writeSessions();
    db.query(`INSERT INTO feedback(id, artifact_id, artifact_kind, author, agent_session_id, body, status,
      target_kind, target_version_seq, target_path, locator_json, legacy_anchor_json,
      created_at, updated_at, sent_at, status_unsent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      artifactId,
      artifact.kind,
      author.role,
      author.sessionId,
      messageBody(row),
      status,
      target.target_kind,
      target.target_version_seq,
      target.target_path,
      target.locator_json,
      JSON.stringify({
        source: row,
        defaults: defaults.records,
        ...(claim ? { expiredClaim: claim } : {}),
      }),
      createdAt,
      updatedAt,
      sentAt,
      row.status_unsent ? 1 : 0,
    );
  }
  for (const row of data.replies) {
    const id = legacyId(row.id);
    const feedbackId = legacyId(row.feedback_id);
    const feedback = data.feedback.find((item) => item.id === feedbackId);
    if (!feedback) throw new Error("Legacy reply has no feedback record");
    const artifactId = legacyId(feedback.review_id);
    const artifact = store.get(artifactId);
    const defaults = context.defaults(`reply:${id}`);
    const createdAt = defaults.time(
      "createdAt",
      row.created_at,
      feedback.created_at ?? artifact.createdAt,
    );
    const author = defaults.actor("author", row.author, undefined, createdAt);
    let versionSeq = legacySeq(row.ref_version);
    if (versionSeq !== null) {
      try {
        store.version(artifactId, versionSeq);
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        versionSeq = null;
        defaults.record(
          "context.versionSeq",
          null,
          "Referenced publication did not survive; retained the original reference",
        );
      }
    }
    // ref_version pinning existed for source @path references. Files source vs.
    // rendered identity was not recorded, so keep that representation unknown.
    const representation = versionSeq !== null && artifact.kind === "diff" ? "diff" : null;
    const original = (await originalTarget(
      store,
      artifactId,
      row,
      defaults,
      true,
    )) as ArtifactVersionTarget | null;
    const target = original === null ? null : targetColumns(original);
    const sentAt = deliveredAt(row, author.role, createdAt, defaults);
    context.writeSessions();
    db.query(`INSERT INTO replies(id, feedback_id, artifact_id, artifact_kind, author, agent_session_id, body,
      context_version_seq, context_representation, target_kind, target_version_seq, target_path, locator_json,
      legacy_reference_json, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      feedbackId,
      artifactId,
      artifact.kind,
      author.role,
      author.sessionId,
      messageBody(row),
      versionSeq,
      representation,
      target?.target_kind ?? null,
      target?.target_version_seq ?? null,
      target?.target_path ?? null,
      target?.locator_json ?? null,
      JSON.stringify({ source: row, defaults: defaults.records }),
      createdAt,
      sentAt,
    );
  }
}
