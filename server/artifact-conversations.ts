import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactActor,
  ArtifactClaim,
  ArtifactComment,
  ArtifactDiscussion,
  ArtifactDiscussionAcknowledgment,
  ArtifactKind,
  ArtifactPlacement,
  ArtifactTarget,
  ArtifactVersionTarget,
  Representation,
} from "../shared/artifacts.ts";
import { artifactReferenceContext, hasUnsentArtifactDiscussion } from "../shared/artifacts.ts";
import type { PreparedAttachment } from "./artifact-attachments.ts";
import { artifactComment, artifactComments } from "./artifact-comments.ts";
import {
  ArtifactTargets,
  type TargetColumns,
  targetColumns,
  targetFromColumns,
} from "./artifact-targets.ts";
import { ArtifactError, requireObject } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { nowIso } from "./ids.ts";

function messageBody(value: unknown, images: number): string {
  if (typeof value !== "string" || value.length > 1024 * 1024 || (!value.trim() && !images))
    throw new ArtifactError(
      "A message needs text or an image (text is limited to 1048576 characters)",
    );
  return value;
}
type AuthoredRow = {
  author: "human" | "agent";
  agent_session_id: string | null;
};
type DiscussionRow = TargetColumns &
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
type CommentRow = Omit<TargetColumns, "target_kind"> &
  AuthoredRow & {
    id: string;
    discussion_id: string;
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
function commentFromRow(row: CommentRow): ArtifactComment {
  return {
    id: row.id,
    discussionId: row.discussion_id,
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
    this.db
      .query(
        "UPDATE artifacts SET updated_at = ?, discussion_revision = discussion_revision + 1 WHERE id = ?",
      )
      .run(time, id);
  }
  private row(id: string): DiscussionRow {
    const row = this.db
      .query<DiscussionRow, [string]>("SELECT * FROM discussions WHERE id = ?")
      .get(id);
    if (!row) throw new ArtifactError("Discussion not found", 404);
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
  private withFrame<T extends ArtifactTarget | null>(
    target: T,
    owner:
      | {
          discussionId: string;
        }
      | {
          commentId: string;
        },
  ): T {
    if (target?.kind !== "media") return target;
    const frame = this.artifacts.attachments.list(owner, "target")[0];
    return { ...target, locator: { ...target.locator, frame } };
  }
  private preparingFrame<T>(
    artifactId: string,
    target: ArtifactTarget | null,
    snapshot: unknown,
    work: (frames: PreparedAttachment[]) => T,
  ): Promise<T> {
    if (target?.kind !== "media") {
      if (snapshot !== undefined)
        throw new ArtifactError("A media snapshot requires a media target");
      return Promise.resolve(work([]));
    }
    const input = requireObject(snapshot, "Media snapshot");
    if (input.id !== undefined || input.capture !== undefined)
      throw new ArtifactError(
        "A media target requires its own unannotated full-frame PNG or JPEG snapshot",
      );
    return this.artifacts.attachments.preparing(artifactId, [input], work);
  }
  async source(id: string) {
    const row = this.row(id);
    return this.targets.sourceRange(row.artifact_id, targetFromColumns(row));
  }
  get(id: string): ArtifactDiscussion {
    const row = this.row(id);
    return {
      id: row.id,
      artifactId: row.artifact_id,
      status: row.status,
      target: this.withFrame(targetFromColumns(row), { discussionId: id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      statusUnsent: !!row.status_unsent,
      claim: this.db
        .query<ArtifactClaim, [string, string]>(`SELECT discussion_id AS discussionId,
        agent_session_id AS sessionId, claimed_at AS claimedAt, renewed_at AS renewedAt, expires_at AS expiresAt
        FROM discussion_claims WHERE discussion_id = ? AND expires_at > ?`)
        .get(id, this.clock()),
      comments: [
        {
          id: `comment_${row.id}`,
          discussionId: row.id,
          artifactId: row.artifact_id,
          createdAt: row.created_at,
          context: artifactReferenceContext(
            this.withFrame(targetFromColumns(row), { discussionId: id }),
          ),
          target: null,
          author: authorFromRow(row),
          body: row.body,
          attachments: this.artifacts.attachments.list({ discussionId: id }),
          sentAt: row.sent_at,
          legacy: row.legacy_anchor_json === null ? null : JSON.parse(row.legacy_anchor_json),
        },
        ...this.db
          .query<CommentRow, [string]>(
            "SELECT * FROM comments WHERE discussion_id = ? ORDER BY created_at, rowid",
          )
          .all(id)
          .map((row) => this.comment(row.id)),
      ],
    };
  }
  list(id: string): ArtifactDiscussion[] {
    this.artifacts.get(id);
    return this.db
      .query<
        {
          id: string;
        },
        [string]
      >("SELECT id FROM discussions WHERE artifact_id = ? ORDER BY created_at, rowid")
      .all(id)
      .map(({ id }) => this.get(id));
  }
  private openingDiscussion(id: string): string | null {
    if (!id.startsWith("comment_")) return null;
    const discussionId = id.slice("comment_".length);
    return this.db.query("SELECT 1 FROM discussions WHERE id=?").get(discussionId)
      ? discussionId
      : null;
  }
  comment(id: string): ArtifactComment {
    const row = this.db.query<CommentRow, [string]>("SELECT * FROM comments WHERE id = ?").get(id);
    if (!row) {
      const opening = this.openingDiscussion(id);
      if (opening) return this.get(opening).comments[0]!;
      const standalone = artifactComment(this.db, id);
      if (standalone) return standalone;
      throw new ArtifactError("Comment not found", 404);
    }
    return {
      ...commentFromRow(row),
      target: this.withFrame(commentFromRow(row).target, { commentId: id }),
      attachments: this.artifacts.attachments.list({ commentId: id }),
    };
  }
  artifactComments(id: string): ArtifactComment[] {
    this.artifacts.get(id);
    return artifactComments(this.db, id);
  }
  pendingComments(id: string): ArtifactComment[] {
    return this.artifactComments(id).filter(
      (comment) => comment.author.role === "human" && comment.sentAt === null,
    );
  }
  hasPending(id: string): boolean {
    return this.unsent(id).length > 0 || this.pendingComments(id).length > 0;
  }
  acknowledgeArchiveComment(id: string): void {
    this.db
      .transaction(() => {
        const comment = artifactComment(this.db, id);
        if (!comment) return;
        // Archive carried revision zero. Restore/edit during delivery must not
        // consume a later edit, even if its text was changed back.
        const result = this.db
          .query(
            "UPDATE artifact_comments SET sent_at=? WHERE id=? AND revision=0 AND sent_at IS NULL",
          )
          .run(this.clock(), id);
        if (result.changes) this.touch(comment.artifactId);
      })
      .immediate();
  }
  async add(id: string, value: unknown): Promise<ArtifactDiscussion> {
    const input = requireObject(value, "Discussion");
    const author = this.artifacts.validateActor(input.actor);
    const native = await this.targets.target(id, input.target);
    const target = targetColumns(native);
    return this.preparingFrame(id, native, input.mediaSnapshot, (frames) =>
      this.artifacts.attachments.preparing(id, input.attachments, (images) =>
        this.db
          .transaction(() => {
            const operation = this.artifacts.attachments.operation(id, input, "discussions", id);
            if (operation.replay) return this.get(operation.replay);
            const body = messageBody(input.body, images.length);
            const artifact = this.artifacts.requireActive(id);
            const time = this.clock();
            const discussionId = `discussion_${randomUUID().replaceAll("-", "")}`;
            this.db
              .query(`INSERT INTO discussions(id, artifact_id, artifact_kind, author, agent_session_id,
        body, target_kind, target_version_seq, target_path, locator_json, created_at, updated_at, sent_at, ever_delivered)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(
                discussionId,
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
            this.artifacts.attachments.replace(id, { discussionId }, images);
            if (frames.length)
              this.artifacts.attachments.replace(id, { discussionId }, frames, "target");
            operation.save({ discussionId });
            this.touch(id, time);
            return this.get(discussionId);
          })
          .immediate(),
      ),
    );
  }
  async update(id: string, value: unknown): Promise<ArtifactDiscussion> {
    const input = requireObject(value, "Discussion edit");
    if (input.attachments === undefined) return this.edit(id, input);
    const row = this.row(id);
    this.editable(this.artifacts.validateActor(input.actor), row);
    return this.artifacts.attachments.preparing(row.artifact_id, input.attachments, (images) =>
      this.edit(id, input, images),
    );
  }
  edit(id: string, value: unknown, images?: PreparedAttachment[]): ArtifactDiscussion {
    const input = requireObject(value, "Discussion edit");
    if (input.attachments !== undefined && !images)
      throw new ArtifactError("Image edits require prepared attachments");
    const author = this.artifacts.validateActor(input.actor);
    if (input.target !== undefined)
      throw new ArtifactError("Original targets are immutable; record a placement");
    return this.db
      .transaction(() => {
        const row = this.row(id);
        this.artifacts.requireActive(row.artifact_id);
        if (input.body !== undefined || images) this.editable(author, row);
        const body = messageBody(
          input.body === undefined ? row.body : input.body,
          images?.length ?? this.artifacts.attachments.list({ discussionId: id }).length,
        );
        const status = input.status === undefined ? row.status : input.status;
        if (status !== "open" && status !== "resolved")
          throw new ArtifactError("Invalid discussions status");
        if (input.status !== undefined && author.role !== "human")
          throw new ArtifactError("Discussion status is controlled by the human owner");
        const imagesChanged = images
          ? this.artifacts.attachments.replace(row.artifact_id, { discussionId: id }, images)
          : false;
        if (body === row.body && status === row.status && !imagesChanged) return this.get(id);
        const time = this.clock();
        const sentAt =
          row.author === "human" && status === "open" && (body !== row.body || imagesChanged)
            ? null
            : row.sent_at;
        const statusUnsent = row.status_unsent || (status !== row.status && row.ever_delivered);
        this.db
          .query(
            "UPDATE discussions SET body = ?, status = ?, sent_at = ?, status_unsent = ?, updated_at = ? WHERE id = ?",
          )
          .run(body, status, sentAt, statusUnsent ? 1 : 0, time, id);
        if (status === "resolved")
          this.db.query("DELETE FROM discussion_claims WHERE discussion_id = ?").run(id);
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
        this.artifacts.requireActive(row.artifact_id);
        this.editable(author, row);
        this.db.query("DELETE FROM discussions WHERE id = ?").run(id);
        this.touch(row.artifact_id);
      })
      .immediate();
  }
  async addComment(id: string, value: unknown): Promise<ArtifactComment> {
    const input = requireObject(value, "Comment");
    const author = this.artifacts.validateActor(input.actor);
    const original = this.row(id);
    const target =
      input.target == null ? null : await this.targets.target(original.artifact_id, input.target);
    if (target?.kind === "artifact" || target?.kind === "artifact_summary")
      throw new ArtifactError("A fix target must name a published version");
    const context = artifactReferenceContext(target, targetFromColumns(original));
    const columns = target === null ? null : targetColumns(target);
    return this.preparingFrame(original.artifact_id, target, input.mediaSnapshot, (frames) =>
      this.artifacts.attachments.preparing(original.artifact_id, input.attachments, (images) =>
        this.db
          .transaction(() => {
            const discussions = this.row(id);
            const operation = this.artifacts.attachments.operation(
              discussions.artifact_id,
              input,
              "comment",
              id,
            );
            if (operation.replay) return this.comment(operation.replay);
            this.artifacts.requireActive(discussions.artifact_id);
            const body = messageBody(input.body, images.length);
            const time = this.clock();
            const commentId = `comment_${randomUUID().replaceAll("-", "")}`;
            this.db
              .query(`INSERT INTO comments(id, discussion_id, artifact_id, artifact_kind, author, agent_session_id,
        body, context_version_seq, context_representation, target_kind, target_version_seq,
        target_path, locator_json, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(
                commentId,
                id,
                discussions.artifact_id,
                discussions.artifact_kind,
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
                .query(
                  "DELETE FROM discussion_claims WHERE discussion_id = ? AND agent_session_id = ?",
                )
                .run(id, author.sessionId);
            }
            this.artifacts.attachments.replace(discussions.artifact_id, { commentId }, images);
            if (frames.length)
              this.artifacts.attachments.replace(
                discussions.artifact_id,
                { commentId },
                frames,
                "target",
              );
            operation.save({ commentId });
            this.touch(discussions.artifact_id, time);
            return this.comment(commentId);
          })
          .immediate(),
      ),
    );
  }
  async updateComment(id: string, value: unknown): Promise<ArtifactComment> {
    const input = requireObject(value, "Comment edit");
    if (input.attachments === undefined) return this.editComment(id, input);
    const comment = this.comment(id);
    this.editable(this.artifacts.validateActor(input.actor), {
      author: comment.author.role,
      agent_session_id: comment.author.sessionId,
    });
    return this.artifacts.attachments.preparing(comment.artifactId, input.attachments, (images) =>
      this.editComment(id, input, images),
    );
  }
  editComment(id: string, value: unknown, images?: PreparedAttachment[]): ArtifactComment {
    const input = requireObject(value, "Comment edit");
    const author = this.artifacts.validateActor(input.actor);
    if (input.attachments !== undefined && !images)
      throw new ArtifactError("Image edits require prepared attachments");
    if (input.target !== undefined || input.context !== undefined)
      throw new ArtifactError("Comment references are immutable");
    if (input.status !== undefined) throw new ArtifactError("Status belongs to a Discussion");
    const opening = this.openingDiscussion(id);
    if (opening) return this.edit(opening, input, images).comments[0]!;
    return this.db
      .transaction(() => {
        const standalone = artifactComment(this.db, id);
        if (standalone) {
          this.artifacts.requireActive(standalone.artifactId);
          this.editable(author, {
            author: standalone.author.role,
            agent_session_id: standalone.author.sessionId,
          });
          if (images?.length) throw new ArtifactError("Archive Comments support text only");
          const body = messageBody(input.body === undefined ? standalone.body : input.body, 0);
          if (body === standalone.body) return standalone;
          this.db
            .query("UPDATE artifact_comments SET body=?,sent_at=?,revision=revision+1 WHERE id=?")
            .run(body, standalone.author.role === "human" ? null : standalone.sentAt, id);
          this.touch(standalone.artifactId);
          return artifactComment(this.db, id)!;
        }
        const row = this.db
          .query<CommentRow, [string]>("SELECT * FROM comments WHERE id = ?")
          .get(id);
        if (!row) throw new ArtifactError("Comment not found", 404);
        this.artifacts.requireActive(row.artifact_id);
        this.editable(author, row);
        const body = messageBody(
          input.body === undefined ? row.body : input.body,
          images?.length ?? this.artifacts.attachments.list({ commentId: id }).length,
        );
        const imagesChanged = images
          ? this.artifacts.attachments.replace(row.artifact_id, { commentId: id }, images)
          : false;
        if (body === row.body && !imagesChanged) return this.comment(id);
        this.db
          .query("UPDATE comments SET body = ?, sent_at = ? WHERE id = ?")
          .run(body, row.author === "human" ? null : row.sent_at, id);
        this.touch(row.artifact_id);
        return this.comment(id);
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
          const discussions = this.get(id);
          if (discussions.status !== "open")
            throw new ArtifactError("Resolved discussions cannot be claimed", 409);
          if (this.artifacts.get(discussions.artifactId).state !== "active")
            throw new ArtifactError("Artifact is archived", 409);
          if (discussions.claim !== null && discussions.claim.sessionId !== sessionId)
            throw new ArtifactError("Discussion is already claimed by another agent", 409);
          const claimedAt = discussions.claim?.claimedAt ?? time;
          this.db
            .query(`INSERT INTO discussion_claims(discussion_id, agent_session_id, claimed_at, renewed_at, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(discussion_id) DO UPDATE SET agent_session_id = excluded.agent_session_id,
          claimed_at = excluded.claimed_at, renewed_at = excluded.renewed_at, expires_at = excluded.expires_at`)
            .run(id, sessionId, claimedAt, time, expiresAt);
          claims.push({ discussionId: id, sessionId, claimedAt, renewedAt: time, expiresAt });
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
            .query("DELETE FROM discussion_claims WHERE discussion_id = ? AND agent_session_id = ?")
            .run(id, sessionId);
      })
      .immediate();
  }
  expireClaims(): string[] {
    return this.db
      .transaction(() => {
        const time = this.clock();
        const affected = this.db
          .query<
            {
              id: string;
            },
            [string]
          >(`SELECT DISTINCT f.artifact_id AS id FROM discussions f
        JOIN discussion_claims c ON c.discussion_id = f.id WHERE c.expires_at <= ?`)
          .all(time)
          .map(({ id }) => id);
        this.db.query("DELETE FROM discussion_claims WHERE expires_at <= ?").run(time);
        return affected;
      })
      .immediate();
  }
  unsent(id: string, only?: string[]): ArtifactDiscussion[] {
    return this.list(id).filter(
      (discussions) =>
        hasUnsentArtifactDiscussion(discussions) && (!only || only.includes(discussions.id)),
    );
  }
  // Bind the acknowledgment to the artifact, selection, and persisted revision.
  // The revision prevents edit/revert cycles from revalidating an old snapshot.
  snapshot(id: string, only?: string[]) {
    if (this.artifacts.get(id).state !== "active")
      throw new ArtifactError("Artifact is archived", 409);
    const revision = this.db
      .query<
        {
          revision: number;
        },
        [string]
      >("SELECT discussion_revision AS revision FROM artifacts WHERE id = ?")
      .get(id)!.revision;
    const discussions = only ? [...new Set(only)].sort() : undefined;
    const expectedFingerprint = createHash("sha256")
      .update(JSON.stringify([id, revision, discussions ?? null]))
      .digest("hex");
    return {
      discussions: this.unsent(id, discussions),
      comments: discussions ? [] : this.pendingComments(id),
      acknowledgment: { discussions, expectedFingerprint },
    };
  }
  acknowledge(id: string, receipt: ArtifactDiscussionAcknowledgment): ArtifactDiscussion[] {
    return this.db
      .transaction(() => {
        const snapshot = this.snapshot(id, receipt.discussions);
        if (receipt.expectedFingerprint !== snapshot.acknowledgment.expectedFingerprint)
          throw new ArtifactError("Discussion changed; fetch it again before acknowledging", 409);
        const discussions = snapshot.discussions;
        const time = this.clock();
        for (const item of discussions) {
          this.db
            .query(
              "UPDATE discussions SET sent_at = COALESCE(sent_at, ?), ever_delivered = 1, status_unsent = 0 WHERE id = ?",
            )
            .run(time, item.id);
          for (const comment of item.comments.slice(1)) {
            if (comment.author.role === "human" && comment.sentAt === null)
              this.db.query("UPDATE comments SET sent_at = ? WHERE id = ?").run(time, comment.id);
          }
        }
        for (const comment of snapshot.comments)
          this.db.query("UPDATE artifact_comments SET sent_at=? WHERE id=?").run(time, comment.id);
        if (discussions.length || snapshot.comments.length) this.touch(id, time);
        return discussions;
      })
      .immediate();
  }
  placements(id: string): ArtifactPlacement[] {
    this.artifacts.get(id);
    type Row = {
      discussion_id: string;
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
        "SELECT * FROM discussion_placements WHERE artifact_id = ? ORDER BY version_seq, document_path, representation",
      )
      .all(id)
      .map((row) => ({
        discussionId: row.discussion_id,
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
