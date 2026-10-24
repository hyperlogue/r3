import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ArtifactActor,
  ArtifactAnchorResolution,
  ArtifactDocumentTarget,
  ArtifactReanchorResult,
  ArtifactThreadAnchor,
} from "../shared/artifacts.ts";
import type { ArtifactAttachment } from "../shared/attachments.ts";
import type { PreparedAttachment } from "./artifact-attachments.ts";
import {
  ArtifactTargets,
  TARGET_LIMITS,
  type TargetColumns,
  targetColumns,
  targetFromColumns,
} from "./artifact-targets.ts";
import {
  ArtifactError,
  canonicalJson,
  requireObject,
  requireSequence,
  requireString,
} from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { hashBytes } from "./blobs.ts";
import { parseUnifiedDiff } from "./git.ts";

type ThreadRow = TargetColumns & { id: string; artifact_id: string; artifact_kind: string };
type AnchorRow = TargetColumns & {
  revision: number;
  author: "human" | "agent";
  agent_session_id: string | null;
  created_at: string;
  updated_at: string;
};

// Original evidence stays in threads. Only this module writes the current
// destination; callers compose commit() with their own message transaction.
export class ArtifactAnchors {
  private readonly targets: ArtifactTargets;
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
    private readonly clock: () => string,
  ) {
    this.targets = new ArtifactTargets(artifacts);
  }
  private thread(id: string): ThreadRow {
    const row = this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id=?").get(id);
    if (!row) throw new ArtifactError("Thread not found", 404);
    return row;
  }
  get(id: string): ArtifactThreadAnchor | null {
    const row = this.db
      .query<AnchorRow, [string]>("SELECT * FROM thread_anchors WHERE thread_id=?")
      .get(id);
    if (!row) return null;
    const target = targetFromColumns(row) as ArtifactDocumentTarget;
    if (target.kind === "media") target.locator.frame = this.frame(id) ?? undefined;
    return {
      target,
      revision: row.revision,
      actor:
        row.author === "human"
          ? { role: "human", sessionId: null }
          : { role: "agent", sessionId: row.agent_session_id! },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private frame(id: string): ArtifactAttachment | null {
    return this.db
      .query<
        ArtifactAttachment,
        [string]
      >(`SELECT a.id, a.artifact_id AS artifactId, a.blob_hash AS hash,
      a.media_type AS mediaType, a.width, a.height, b.byte_length AS byteLength
      FROM thread_anchor_frames a JOIN blobs b ON b.hash=a.blob_hash WHERE a.thread_id=?`)
      .get(id);
  }
  guard(id: string, value: unknown): { expectedSeq: number; expectedAnchorRevision: number } {
    const input = requireObject(value, "Re-anchor guard");
    const expectedSeq = requireSequence(input.expectedSeq);
    const expectedAnchorRevision = requireSequence(input.expectedAnchorRevision, true);
    const row = this.thread(id);
    this.artifacts.requireActive(row.artifact_id);
    if (this.artifacts.get(row.artifact_id).latestVersion?.seq !== expectedSeq)
      throw new ArtifactError("Re-anchor conflict: latest publication changed", 409);
    if ((this.get(id)?.revision ?? 0) !== expectedAnchorRevision)
      throw new ArtifactError(`Re-anchor conflict for ${id}: anchor revision changed`, 409);
    return { expectedSeq, expectedAnchorRevision };
  }
  async prepare(artifactId: string, value: unknown): Promise<ArtifactDocumentTarget> {
    const target = requireObject(value, "Anchor destination");
    if (!["source", "rendered", "diff", "media"].includes(String(target.kind)))
      throw new ArtifactError("A re-anchor needs a native document destination");
    const locator =
      target.locator === null ? null : requireObject(target.locator, "Anchor locator");
    for (const object of [target, locator]) {
      if (object && ["quote", "prefix", "suffix", "frame"].some((key) => key in object))
        throw new ArtifactError(
          "Thread quotes are immutable; supply destination coordinates without quote, prefix, suffix or frame",
        );
    }
    if ((target.kind === "source" || target.kind === "diff") && locator) {
      const candidate = {
        ...target,
        locator: { ...locator, quote: "capture" },
      } as unknown as ArtifactDocumentTarget;
      const range = await this.targets.sourceRange(artifactId, candidate, false);
      // An exact bounded excerpt is navigation evidence, not a replacement for
      // the original quotation. Full ranges remain readable from retained bytes.
      const quote = range.text.slice(0, TARGET_LIMITS.quote);
      return (await this.targets.target(artifactId, {
        ...target,
        locator: { ...locator, quote },
      })) as ArtifactDocumentTarget;
    }
    return (await this.targets.target(artifactId, target)) as ArtifactDocumentTarget;
  }
  async preparingFrame<T>(
    artifactId: string,
    target: ArtifactDocumentTarget,
    snapshot: unknown,
    work: (frames: PreparedAttachment[]) => T,
  ): Promise<T> {
    if (target.kind !== "media") {
      if (snapshot !== undefined)
        throw new ArtifactError("A media snapshot requires a media destination");
      return work([]);
    }
    const image = requireObject(snapshot, "Media snapshot");
    if (image.id !== undefined || image.capture !== undefined)
      throw new ArtifactError("A media anchor requires its own full-frame PNG/JPEG snapshot");
    return this.artifacts.attachments.preparing(artifactId, [image], work);
  }
  // All guards are rechecked after preparation, inside the caller's transaction.
  commit(
    id: string,
    target: ArtifactDocumentTarget,
    actor: ArtifactActor,
    guard: unknown,
    frames: PreparedAttachment[],
  ) {
    if (!this.db.inTransaction) throw new Error("Anchor writes require a transaction");
    const expected = this.guard(id, guard);
    if (target.versionSeq !== expected.expectedSeq)
      throw new ArtifactError("Re-anchor destination must name the latest publication");
    const row = this.thread(id);
    const current = this.get(id);
    const image = frames[0];
    if (target.kind === "media" && (!image || "existing" in image))
      throw new ArtifactError("A media anchor requires a new snapshot");
    const old = current?.target ?? targetFromColumns(row);
    const withoutFrame = (value: typeof old) =>
      value.kind === "media"
        ? { ...value, locator: { time: value.locator.time, box: value.locator.box } }
        : value;
    if (
      canonicalJson(withoutFrame(old)) === canonicalJson(withoutFrame(target)) &&
      (target.kind !== "media" ||
        (image &&
          !("existing" in image) &&
          current?.target.kind === "media" &&
          current.target.locator.frame?.hash === image.hash))
    )
      return { threadId: id, revision: current?.revision ?? 0, changed: false };
    const revision = (current?.revision ?? 0) + 1;
    const time = this.clock();
    const columns = targetColumns(target);
    this.db.query("DELETE FROM thread_anchor_frames WHERE thread_id=?").run(id);
    this.db
      .query(`INSERT INTO thread_anchors(thread_id, artifact_id, artifact_kind, revision,
      target_kind, target_version_seq, target_path, locator_json, author, agent_session_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET
      revision=excluded.revision, target_kind=excluded.target_kind, target_version_seq=excluded.target_version_seq,
      target_path=excluded.target_path, locator_json=excluded.locator_json, author=excluded.author,
      agent_session_id=excluded.agent_session_id, updated_at=excluded.updated_at`)
      .run(
        id,
        row.artifact_id,
        row.artifact_kind,
        revision,
        columns.target_kind,
        columns.target_version_seq,
        columns.target_path,
        columns.locator_json,
        actor.role,
        actor.sessionId,
        time,
        time,
      );
    if (image && !("existing" in image)) {
      this.db
        .query(
          "INSERT INTO blobs(hash, byte_length, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(image.hash, image.byteLength, time);
      this.db
        .query(`INSERT INTO thread_anchor_frames(id,thread_id,artifact_id,anchor_revision,blob_hash,media_type,width,height)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          `image_${randomUUID().replaceAll("-", "")}`,
          id,
          row.artifact_id,
          revision,
          image.hash,
          image.mediaType,
          image.width,
          image.height,
        );
    }
    return { threadId: id, revision, changed: true };
  }
  async reanchor(artifactId: string, value: unknown): Promise<ArtifactReanchorResult> {
    const input = requireObject(value, "Re-anchor batch");
    const actor = this.artifacts.validateActor(input.actor);
    const expectedSeq = requireSequence(input.expectedSeq);
    const key = requireString(input.operationKey, "Operation key", 200);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100)
      throw new ArtifactError("Supply between 1 and 100 re-anchor entries");
    const items = input.items.map((value) => {
      const item = requireObject(value, "Re-anchor entry");
      return {
        ...item,
        threadId: requireString(item.threadId, "Thread ID", 200),
        expectedAnchorRevision: requireSequence(item.expectedAnchorRevision, true),
        target: item.target,
        mediaSnapshot: item.mediaSnapshot,
      };
    });
    if (new Set(items.map((item) => item.threadId)).size !== items.length)
      throw new ArtifactError("Duplicate thread in re-anchor batch");
    const hash = hashBytes(canonicalJson(input));
    const replay = () => {
      const row = this.db
        .query<{ request_hash: string; result_json: string }, [string, string]>(
          "SELECT * FROM thread_anchor_operations WHERE artifact_id=? AND operation_key=?",
        )
        .get(artifactId, key);
      if (row && row.request_hash !== hash)
        throw new ArtifactError("Operation key was used for a different re-anchor", 409);
      return row
        ? ({ operationKey: key, results: JSON.parse(row.result_json) } as ArtifactReanchorResult)
        : null;
    };
    const previous = replay();
    if (previous) return previous;
    this.artifacts.requireActive(artifactId);
    // Nested preparation keeps every prepared frame under a GC hold until the
    // single atomic commit. No membership becomes visible during preparation.
    const prepared: { target: ArtifactDocumentTarget; frames: PreparedAttachment[] }[] = [];
    const prepare = async (index: number): Promise<ArtifactReanchorResult> => {
      const item = items[index];
      if (item) {
        try {
          if (this.thread(item.threadId).artifact_id !== artifactId)
            throw new ArtifactError("Thread belongs to a different artifact");
          const target = await this.prepare(artifactId, item.target);
          return await this.preparingFrame(artifactId, target, item.mediaSnapshot, (frames) => {
            prepared.push({ target, frames });
            return prepare(index + 1);
          });
        } catch (error) {
          if (error instanceof ArtifactError)
            throw new ArtifactError(`${item.threadId}: ${error.message}`, error.status);
          throw error;
        }
      }
      return this.db
        .transaction(() => {
          const previous = replay();
          if (previous) return previous;
          const results = items.map((item, index) => {
            if (this.thread(item.threadId).artifact_id !== artifactId)
              throw new ArtifactError("Thread membership changed", 409);
            return this.commit(
              item.threadId,
              prepared[index]!.target,
              actor,
              { expectedSeq, expectedAnchorRevision: item.expectedAnchorRevision },
              prepared[index]!.frames,
            );
          });
          if (results.some((result) => result.changed))
            this.db
              .query(
                "UPDATE artifacts SET updated_at=?, discussion_revision=discussion_revision+1 WHERE id=?",
              )
              .run(this.clock(), artifactId);
          this.db
            .query(
              "INSERT INTO thread_anchor_operations(artifact_id,operation_key,request_hash,result_json,created_at) VALUES (?,?,?,?,?)",
            )
            .run(artifactId, key, hash, JSON.stringify(results), this.clock());
          return { operationKey: key, results };
        })
        .immediate();
    };
    return prepare(0);
  }

  async resolve(id: string, versionSeq: number): Promise<ArtifactAnchorResolution> {
    const row = this.thread(id);
    this.artifacts.version(row.artifact_id, versionSeq);
    const anchor = this.get(id);
    const original = anchor?.target ?? targetFromColumns(row);
    const result: ArtifactAnchorResolution = {
      threadId: id,
      anchorRevision: anchor?.revision ?? 0,
      versionSeq,
      state: "unplaced",
      target: null,
    };
    if (!["source", "rendered", "diff", "media"].includes(original.kind)) return result;
    const saved = original as ArtifactDocumentTarget;
    if (saved.kind === "media" && !saved.locator.frame)
      saved.locator.frame = this.artifacts.attachments.list({ threadId: id }, "target")[0];
    let candidate: ArtifactDocumentTarget = { ...saved, versionSeq };
    try {
      if (
        (saved.kind === "source" || saved.kind === "diff") &&
        saved.locator &&
        saved.versionSeq !== versionSeq
      ) {
        const range = await this.targets.sourceRange(row.artifact_id, saved);
        const wanted = range.text.split("\n");
        let lines: { line: number; text: string }[];
        if (saved.kind === "source") {
          const bytes = await this.artifacts.readFile(row.artifact_id, versionSeq, saved.path);
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            return result;
          }
          if (text.includes("\0")) return result;
          const all = text.replaceAll("\r\n", "\n").split("\n");
          if (text.endsWith("\n")) all.pop();
          lines = all.map((text, index) => ({ line: index + 1, text }));
        } else {
          const file = parseUnifiedDiff(this.artifacts.patch(row.artifact_id, versionSeq)).find(
            (file) => file.path === saved.path || file.oldPath === saved.path,
          );
          if (!file) return result;
          lines = file.lines.flatMap((line) => {
            const number = saved.locator!.side === "old" ? line.oldLine : line.newLine;
            return number === null ? [] : [{ line: number, text: line.text }];
          });
        }
        const matches: number[] = [];
        for (let index = 0; index <= lines.length - wanted.length; index++) {
          if (
            wanted.every(
              (text, offset) =>
                lines[index + offset]!.text === text &&
                lines[index + offset]!.line === lines[index]!.line + offset,
            )
          ) {
            matches.push(lines[index]!.line);
            if (matches.length > 1) return { ...result, state: "ambiguous" };
          }
        }
        if (!matches.length) return result;
        const locator = {
          start: matches[0]!,
          end: matches[0]! + wanted.length - 1,
          quote: saved.locator.quote,
        };
        candidate =
          saved.kind === "diff"
            ? { ...saved, versionSeq, locator: { ...locator, side: saved.locator.side } }
            : { ...saved, versionSeq, locator };
      } else if (saved.kind === "media") {
        if (
          this.artifacts.file(row.artifact_id, saved.versionSeq, saved.path).hash !==
          this.artifacts.file(row.artifact_id, versionSeq, saved.path).hash
        )
          return result;
      }
      const validated = (await this.targets.target(
        row.artifact_id,
        candidate,
      )) as ArtifactDocumentTarget;
      // Saved snapshot ownership is unchanged during read-only navigation.
      if (validated.kind === "media" && saved.kind === "media")
        validated.locator.frame = saved.locator.frame;
      return {
        ...result,
        state: validated.kind === "rendered" ? "runtime-required" : "anchored",
        target: validated,
      };
    } catch (error) {
      if (error instanceof ArtifactError && [400, 404].includes(error.status)) return result;
      throw error;
    }
  }
}
