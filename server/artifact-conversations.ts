import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactActor,
  ArtifactClaim,
  ArtifactFeedback,
  ArtifactKind,
  ArtifactPlacement,
  ArtifactReply,
  ArtifactVersionTarget,
  Representation,
} from "../shared/artifacts.ts";
import { hasUnsentArtifactFeedback } from "../shared/artifacts.ts";
import {
  ArtifactTargets,
  type TargetColumns,
  targetColumns,
  targetFromColumns,
} from "./artifact-targets.ts";
import { ArtifactError, requireObject, requireString } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { nowIso } from "./ids.ts";

type AuthoredRow = { author: "human" | "agent"; agent_session_id: string | null };

export function artifactDeliveryFingerprint(feedback: ArtifactFeedback[]): string {
  const snapshot = feedback.map((item) => ({
    id: item.id,
    body: item.body,
    status: item.status,
    sentAt: item.sentAt,
    statusUnsent: item.statusUnsent,
    replies: item.replies.map((reply) => ({
      id: reply.id,
      body: reply.body,
      sentAt: reply.sentAt,
    })),
  }));
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
type FeedbackRow = TargetColumns &
  AuthoredRow & {
    id: string;
    artifact_id: string;
    artifact_kind: ArtifactKind;
    body: string;
    status: "open" | "resolved";
    legacy_anchor_json: string | null;
    created_at: string;
    updated_at: string;
    sent_at: string | null;
    ever_delivered: number;
    status_unsent: number;
  };
type ReplyRow = Omit<TargetColumns, "target_kind"> &
  AuthoredRow & {
    id: string;
    feedback_id: string;
    artifact_id: string;
    body: string;
    context_version_seq: number | null;
    context_representation: Representation | null;
    target_kind: ArtifactVersionTarget["kind"] | null;
    legacy_reference_json: string | null;
    created_at: string;
    sent_at: string | null;
  };

function authorFromRow(row: AuthoredRow): ArtifactActor {
  return row.author === "human"
    ? { role: "human", sessionId: null }
    : { role: "agent", sessionId: row.agent_session_id! };
}

function replyFromRow(row: ReplyRow): ArtifactReply {
  return {
    id: row.id,
    feedbackId: row.feedback_id,
    artifactId: row.artifact_id,
    author: authorFromRow(row),
    body: row.body,
    context:
      row.context_version_seq === null
        ? { versionSeq: null, representation: null }
        : {
            versionSeq: row.context_version_seq,
            representation: row.context_representation,
          },
    target:
      row.target_kind === null
        ? null
        : (targetFromColumns({ ...row, target_kind: row.target_kind }) as ArtifactVersionTarget),
    legacy: row.legacy_reference_json === null ? null : JSON.parse(row.legacy_reference_json),
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

// Conversation writes and delivery stamps share one store transaction. SSE and
// wakeup transports are owned by the collaboration boundary, after commit.
export class ArtifactConversations {
  private readonly targets: ArtifactTargets;

  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
    private readonly clock: () => string = nowIso,
  ) {
    this.targets = new ArtifactTargets(artifacts);
  }

  private touch(id: string, time = this.clock()): void {
    this.db.query("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(time, id);
  }

  private row(id: string): FeedbackRow {
    const row = this.db.query<FeedbackRow, [string]>("SELECT * FROM feedback WHERE id = ?").get(id);
    if (!row) throw new ArtifactError("Feedback not found", 404);
    return row;
  }

  private editable(author: ArtifactActor, original: AuthoredRow): void {
    if (
      author.role === "agent" &&
      (original.author !== "agent" || original.agent_session_id !== author.sessionId)
    ) {
      throw new ArtifactError("Agents may edit only their own messages");
    }
  }

  get(id: string): ArtifactFeedback {
    const row = this.row(id);
    return {
      id: row.id,
      artifactId: row.artifact_id,
      author: authorFromRow(row),
      body: row.body,
      status: row.status,
      target: targetFromColumns(row),
      legacy: row.legacy_anchor_json === null ? null : JSON.parse(row.legacy_anchor_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
      statusUnsent: !!row.status_unsent,
      replies: this.db
        .query<ReplyRow, [string]>(
          "SELECT * FROM replies WHERE feedback_id = ? ORDER BY created_at, rowid",
        )
        .all(id)
        .map(replyFromRow),
      claim: this.db
        .query<ArtifactClaim, [string, string]>(`SELECT feedback_id AS feedbackId,
        agent_session_id AS sessionId, claimed_at AS claimedAt, renewed_at AS renewedAt, expires_at AS expiresAt
        FROM feedback_claims WHERE feedback_id = ? AND expires_at > ?`)
        .get(id, this.clock()),
    };
  }

  list(id: string): ArtifactFeedback[] {
    this.artifacts.get(id);
    return this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM feedback WHERE artifact_id = ? ORDER BY created_at, rowid",
      )
      .all(id)
      .map(({ id }) => this.get(id));
  }

  reply(id: string): ArtifactReply {
    const row = this.db.query<ReplyRow, [string]>("SELECT * FROM replies WHERE id = ?").get(id);
    if (!row) throw new ArtifactError("Reply not found", 404);
    return replyFromRow(row);
  }

  async add(id: string, value: unknown): Promise<ArtifactFeedback> {
    const input = requireObject(value, "Feedback");
    const author = this.artifacts.validateActor(input.actor);
    const body = requireString(input.body, "Feedback body");
    const target = targetColumns(await this.targets.target(id, input.target));
    return this.db
      .transaction(() => {
        const artifact = this.artifacts.get(id);
        const time = this.clock();
        const feedbackId = `feedback_${randomUUID().replaceAll("-", "")}`;
        this.db
          .query(`INSERT INTO feedback(id, artifact_id, artifact_kind, author, agent_session_id,
        body, target_kind, target_version_seq, target_path, locator_json, created_at, updated_at, sent_at, ever_delivered)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            feedbackId,
            id,
            artifact.kind,
            author.role,
            author.sessionId,
            body,
            target.target_kind,
            target.target_version_seq,
            target.target_path,
            target.locator_json,
            time,
            time,
            author.role === "agent" ? time : null,
            author.role === "agent" ? 1 : 0,
          );
        this.touch(id, time);
        return this.get(feedbackId);
      })
      .immediate();
  }

  edit(id: string, value: unknown): ArtifactFeedback {
    const input = requireObject(value, "Feedback edit");
    const author = this.artifacts.validateActor(input.actor);
    if (input.target !== undefined)
      throw new ArtifactError("Original targets are immutable; record a placement");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        if (input.body !== undefined) this.editable(author, row);
        const body =
          input.body === undefined ? row.body : requireString(input.body, "Feedback body");
        const status = input.status === undefined ? row.status : input.status;
        if (status !== "open" && status !== "resolved")
          throw new ArtifactError("Invalid feedback status");
        if (input.status !== undefined && author.role !== "human")
          throw new ArtifactError("Feedback status is controlled by the human owner");
        if (body === row.body && status === row.status) return this.get(id);
        const time = this.clock();
        const sentAt =
          row.author === "human" && status === "open" && body !== row.body ? null : row.sent_at;
        const statusUnsent = row.status_unsent || (status !== row.status && row.ever_delivered);
        this.db
          .query(
            "UPDATE feedback SET body = ?, status = ?, sent_at = ?, status_unsent = ?, updated_at = ? WHERE id = ?",
          )
          .run(body, status, sentAt, statusUnsent ? 1 : 0, time, id);
        if (status === "resolved")
          this.db.query("DELETE FROM feedback_claims WHERE feedback_id = ?").run(id);
        this.touch(row.artifact_id, time);
        return this.get(id);
      })
      .immediate();
  }

  delete(id: string, actor: unknown): void {
    const author = this.artifacts.validateActor(actor);
    this.db
      .transaction(() => {
        const row = this.row(id);
        this.editable(author, row);
        this.db.query("DELETE FROM feedback WHERE id = ?").run(id);
        this.touch(row.artifact_id);
      })
      .immediate();
  }

  async addReply(id: string, value: unknown): Promise<ArtifactReply> {
    const input = requireObject(value, "Reply");
    const author = this.artifacts.validateActor(input.actor);
    const body = requireString(input.body, "Reply body");
    const original = this.row(id);
    const context = this.targets.context(original.artifact_id, input.context);
    const target =
      input.target == null ? null : await this.targets.target(original.artifact_id, input.target);
    if (target?.kind === "artifact" || target?.kind === "artifact_summary")
      throw new ArtifactError("A fix target must name a published version");
    const columns = target === null ? null : targetColumns(target);
    return this.db
      .transaction(() => {
        const feedback = this.row(id);
        const time = this.clock();
        const replyId = `reply_${randomUUID().replaceAll("-", "")}`;
        this.db
          .query(`INSERT INTO replies(id, feedback_id, artifact_id, artifact_kind, author, agent_session_id,
        body, context_version_seq, context_representation, target_kind, target_version_seq,
        target_path, locator_json, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            replyId,
            id,
            feedback.artifact_id,
            feedback.artifact_kind,
            author.role,
            author.sessionId,
            body,
            context.versionSeq,
            context.representation,
            columns?.target_kind ?? null,
            columns?.target_version_seq ?? null,
            columns?.target_path ?? null,
            columns?.locator_json ?? null,
            time,
            author.role === "agent" ? time : null,
          );
        if (author.role === "agent") {
          this.db
            .query("DELETE FROM feedback_claims WHERE feedback_id = ? AND agent_session_id = ?")
            .run(id, author.sessionId);
        }
        this.touch(feedback.artifact_id, time);
        return this.reply(replyId);
      })
      .immediate();
  }

  editReply(id: string, value: unknown): ArtifactReply {
    const input = requireObject(value, "Reply edit");
    const author = this.artifacts.validateActor(input.actor);
    const body = requireString(input.body, "Reply body");
    if (input.target !== undefined || input.context !== undefined)
      throw new ArtifactError("Reply references are immutable");
    return this.db
      .transaction(() => {
        const row = this.db.query<ReplyRow, [string]>("SELECT * FROM replies WHERE id = ?").get(id);
        if (!row) throw new ArtifactError("Reply not found", 404);
        this.editable(author, row);
        if (body === row.body) return replyFromRow(row);
        this.db
          .query("UPDATE replies SET body = ?, sent_at = ? WHERE id = ?")
          .run(body, row.author === "human" ? null : row.sent_at, id);
        this.touch(row.artifact_id);
        return this.reply(id);
      })
      .immediate();
  }

  claim(ids: string[], sessionId: string): ArtifactClaim[] {
    this.artifacts.validateActor({ role: "agent", sessionId });
    return this.db
      .transaction(() => {
        const time = this.clock();
        const expiresAt = new Date(Date.parse(time) + 60 * 60 * 1000).toISOString();
        const claims: ArtifactClaim[] = [];
        for (const id of new Set(ids)) {
          const feedback = this.get(id);
          if (feedback.status !== "open")
            throw new ArtifactError("Resolved feedback cannot be claimed", 409);
          if (this.artifacts.get(feedback.artifactId).state !== "active")
            throw new ArtifactError("Artifact is archived", 409);
          if (feedback.claim !== null && feedback.claim.sessionId !== sessionId)
            throw new ArtifactError("Feedback is already claimed by another agent", 409);
          const claimedAt = feedback.claim?.claimedAt ?? time;
          this.db
            .query(`INSERT INTO feedback_claims(feedback_id, agent_session_id, claimed_at, renewed_at, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(feedback_id) DO UPDATE SET agent_session_id = excluded.agent_session_id,
          claimed_at = excluded.claimed_at, renewed_at = excluded.renewed_at, expires_at = excluded.expires_at`)
            .run(id, sessionId, claimedAt, time, expiresAt);
          claims.push({ feedbackId: id, sessionId, claimedAt, renewedAt: time, expiresAt });
        }
        return claims;
      })
      .immediate();
  }

  release(ids: string[], sessionId: string): void {
    this.artifacts.validateActor({ role: "agent", sessionId });
    this.db
      .transaction(() => {
        for (const id of new Set(ids))
          this.db
            .query("DELETE FROM feedback_claims WHERE feedback_id = ? AND agent_session_id = ?")
            .run(id, sessionId);
      })
      .immediate();
  }

  expireClaims(): string[] {
    return this.db
      .transaction(() => {
        const time = this.clock();
        const affected = this.db
          .query<{ id: string }, [string]>(`SELECT DISTINCT f.artifact_id AS id FROM feedback f
        JOIN feedback_claims c ON c.feedback_id = f.id WHERE c.expires_at <= ?`)
          .all(time)
          .map(({ id }) => id);
        this.db.query("DELETE FROM feedback_claims WHERE expires_at <= ?").run(time);
        return affected;
      })
      .immediate();
  }

  unsent(id: string, only?: string[]): ArtifactFeedback[] {
    return this.list(id).filter(
      (feedback) => hasUnsentArtifactFeedback(feedback) && (!only || only.includes(feedback.id)),
    );
  }

  // Reads never mark delivery. An explicit owner handoff drains a transaction's
  // exact snapshot, so later edits/replies cannot accidentally be stamped sent.
  deliver(id: string, only?: string[], expectedFingerprint?: string): ArtifactFeedback[] {
    return this.db
      .transaction(() => {
        if (this.artifacts.get(id).state !== "active")
          throw new ArtifactError("Artifact is archived", 409);
        const feedback = this.unsent(id, only);
        if (
          expectedFingerprint !== undefined &&
          expectedFingerprint !== artifactDeliveryFingerprint(feedback)
        )
          throw new ArtifactError("Pending feedback changed; copy the updated prompt again", 409);
        const time = this.clock();
        for (const item of feedback) {
          this.db
            .query(
              "UPDATE feedback SET sent_at = COALESCE(sent_at, ?), ever_delivered = 1, status_unsent = 0 WHERE id = ?",
            )
            .run(time, item.id);
          for (const reply of item.replies) {
            if (reply.author.role === "human" && reply.sentAt === null)
              this.db.query("UPDATE replies SET sent_at = ? WHERE id = ?").run(time, reply.id);
          }
        }
        if (feedback.length) this.touch(id, time);
        return feedback;
      })
      .immediate();
  }

  async place(id: string, value: unknown): Promise<ArtifactPlacement> {
    const input = requireObject(value, "Placement");
    this.artifacts.validateActor(input.actor);
    const state = input.state;
    if (state !== "anchored" && state !== "unplaced" && state !== "ambiguous")
      throw new ArtifactError("Invalid placement state");
    const feedback = this.row(id);
    const target = await this.targets.target(
      feedback.artifact_id,
      input.target,
      state !== "anchored",
    );
    if (target.kind !== "source" && target.kind !== "rendered" && target.kind !== "diff")
      throw new ArtifactError("Placement must name a document representation");
    if (state !== "anchored" && target.locator !== null)
      throw new ArtifactError("Unavailable placements cannot claim a locator");
    const time = this.clock();
    this.db
      .transaction(() => {
        this.row(id);
        this.db
          .query(`INSERT INTO feedback_placements(feedback_id, artifact_id, artifact_kind, version_seq,
        document_path, representation, match_state, locator_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feedback_id, version_seq, document_path, representation)
        DO UPDATE SET match_state = excluded.match_state, locator_json = excluded.locator_json, updated_at = excluded.updated_at`)
          .run(
            id,
            feedback.artifact_id,
            feedback.artifact_kind,
            target.versionSeq,
            target.path,
            target.kind,
            state,
            target.locator === null ? null : JSON.stringify(target.locator),
            time,
            time,
          );
        this.touch(feedback.artifact_id, time);
      })
      .immediate();
    return this.placements(feedback.artifact_id).find(
      (placement) =>
        placement.feedbackId === id &&
        placement.target.versionSeq === target.versionSeq &&
        placement.target.path === target.path &&
        placement.target.kind === target.kind,
    )!;
  }

  placements(id: string): ArtifactPlacement[] {
    this.artifacts.get(id);
    type Row = {
      feedback_id: string;
      artifact_id: string;
      version_seq: number;
      document_path: string;
      representation: Representation;
      match_state: ArtifactPlacement["state"];
      locator_json: string | null;
      created_at: string;
      updated_at: string;
    };
    return this.db
      .query<Row, [string]>(
        "SELECT * FROM feedback_placements WHERE artifact_id = ? ORDER BY version_seq, document_path, representation",
      )
      .all(id)
      .map((row) => ({
        feedbackId: row.feedback_id,
        artifactId: row.artifact_id,
        target: {
          kind: row.representation,
          versionSeq: row.version_seq,
          path: row.document_path,
          locator: row.locator_json === null ? null : JSON.parse(row.locator_json),
        },
        state: row.match_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }
}
