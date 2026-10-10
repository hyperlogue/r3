import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  type ArtifactAttachment,
  ATTACHMENT_LIMITS,
  type AttachmentCapture,
} from "../shared/attachments.ts";
import {
  ArtifactError,
  canonicalJson,
  requireArtifactPath,
  requireObject,
  requireSequence,
  requireString,
} from "./artifact-validation.ts";
import { prepareAttachmentImage } from "./attachment-image.ts";
import { type BlobStore, hashBytes } from "./blobs.ts";

export const ATTACHMENT_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS thread_attachment_owner ON threads(id, artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS comment_attachment_owner ON comments(id, artifact_id);
CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  thread_id TEXT,
  comment_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'message' CHECK (purpose IN ('message', 'target')),
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 4),
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0 AND width * height <= 20000000),
  capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
  CHECK ((thread_id IS NULL) != (comment_id IS NULL)),
  FOREIGN KEY (thread_id, artifact_id) REFERENCES threads(id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id, artifact_id) REFERENCES comments(id, artifact_id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER IF NOT EXISTS immutable_message_attachment
BEFORE UPDATE OF id, artifact_id, thread_id, comment_id, blob_hash, media_type, width, height, capture_json, purpose
ON message_attachments BEGIN SELECT RAISE(ABORT, 'Attachment evidence is immutable'); END;
CREATE UNIQUE INDEX IF NOT EXISTS target_frame_threads ON message_attachments(thread_id) WHERE purpose = 'target';
CREATE UNIQUE INDEX IF NOT EXISTS target_frame_comment ON message_attachments(comment_id) WHERE purpose = 'target';
CREATE INDEX IF NOT EXISTS attachments_threads ON message_attachments(thread_id);
CREATE INDEX IF NOT EXISTS attachments_comment ON message_attachments(comment_id);
CREATE TABLE IF NOT EXISTS message_operations (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  thread_id TEXT,
  comment_id TEXT,
  PRIMARY KEY (artifact_id, operation_key),
  CHECK ((thread_id IS NULL) != (comment_id IS NULL)),
  FOREIGN KEY (thread_id, artifact_id) REFERENCES threads(id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id, artifact_id) REFERENCES comments(id, artifact_id) ON DELETE CASCADE
) STRICT;
`;

type ImageRow = ArtifactAttachment & { captureJson: string | null };
export type PreparedAttachment =
  | { existing: string }
  | Omit<ArtifactAttachment, "id" | "artifactId">;
type Owner = { threadId: string } | { commentId: string };
const ownerColumn = (owner: Owner) => ("threadId" in owner ? "thread_id" : "comment_id");
const ownerId = (owner: Owner) => ("threadId" in owner ? owner.threadId : owner.commentId);
const select = `SELECT a.id, a.artifact_id AS artifactId, a.blob_hash AS hash,
  a.media_type AS mediaType, a.width, a.height, b.byte_length AS byteLength,
  a.capture_json AS captureJson FROM message_attachments a JOIN blobs b ON b.hash = a.blob_hash`;
const fromRow = ({ captureJson, ...row }: ImageRow): ArtifactAttachment => ({
  ...row,
  ...(captureJson ? { capture: JSON.parse(captureJson) } : {}),
});

export class ArtifactAttachments {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
    private readonly clock: () => string,
  ) {}

  list(owner: Owner, purpose: "message" | "target" = "message"): ArtifactAttachment[] {
    return this.db
      .query<ImageRow, [string, string]>(
        `${select} WHERE a.${ownerColumn(owner)} = ? AND a.purpose = ? ORDER BY a.position`,
      )
      .all(ownerId(owner), purpose)
      .map(fromRow);
  }

  async read(artifactId: string, id: string) {
    // Acquire the GC hold before looking up membership as well as reading bytes.
    return this.blobs.publishing(async () => {
      const row = this.db
        .query<ImageRow, [string, string]>(`${select} WHERE a.artifact_id = ? AND a.id = ?`)
        .get(artifactId, id);
      if (!row) throw new ArtifactError("Attachment not found", 404);
      return { attachment: fromRow(row), bytes: await this.blobs.read(row.hash) };
    });
  }

  async preparing<T>(
    artifactId: string,
    value: unknown,
    work: (images: PreparedAttachment[]) => T,
  ): Promise<T> {
    if (value === undefined) return work([]);
    if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.count)
      throw new ArtifactError("A message can contain at most four images");
    return this.blobs.publishing(async () => {
      const images: PreparedAttachment[] = [];
      for (const raw of value) {
        const input = requireObject(raw, "Attachment");
        if (input.id !== undefined) {
          if (Object.keys(input).some((key) => key !== "id"))
            throw new ArtifactError("An existing attachment accepts only its ID");
          images.push({ existing: requireString(input.id, "Attachment ID", 200) });
          continue;
        }
        if (Object.keys(input).some((key) => !["base64", "mediaType", "capture"].includes(key)))
          throw new ArtifactError("Unknown attachment field");
        const base64 = requireString(
          input.base64,
          "Image bytes",
          Math.ceil(ATTACHMENT_LIMITS.bytes / 3) * 4,
        );
        const bytes = Buffer.from(base64, "base64");
        if (bytes.toString("base64") !== base64)
          throw new ArtifactError("Invalid base64 image bytes");
        const image = prepareAttachmentImage(bytes, input.mediaType);
        const capture =
          input.capture === undefined ? undefined : this.capture(artifactId, input.capture);
        const stored = await this.blobs.put(image.bytes);
        images.push({
          ...stored,
          width: image.width,
          height: image.height,
          mediaType: image.mediaType,
          ...(capture ? { capture } : {}),
        });
      }
      return work(images);
    });
  }

  // Called inside the conversation transaction; existing IDs never move between messages.
  replace(
    artifactId: string,
    owner: Owner,
    images: PreparedAttachment[],
    purpose: "message" | "target" = "message",
  ) {
    const current = this.list(owner, purpose);
    if (purpose === "target" && current.length)
      throw new ArtifactError("Media evidence is immutable");
    const retained = images.flatMap((image) => ("existing" in image ? [image.existing] : []));
    if (
      new Set(retained).size !== retained.length ||
      retained.some((id) => !current.some((image) => image.id === id))
    )
      throw new ArtifactError("Attachment does not belong to this message");
    const signature = images.map((image) => ("existing" in image ? image.existing : null));
    if (
      signature.length === current.length &&
      signature.every((id, index) => id === current[index]!.id)
    )
      return false;
    for (const image of current)
      if (!retained.includes(image.id))
        this.db.query("DELETE FROM message_attachments WHERE id = ?").run(image.id);
    images.forEach((image, position) => {
      if ("existing" in image) {
        this.db
          .query("UPDATE message_attachments SET position = ? WHERE id = ?")
          .run(position, image.existing);
        return;
      }
      this.db
        .query(
          "INSERT INTO blobs(hash, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(image.hash, image.byteLength, this.clock());
      this.db
        .query(
          `INSERT INTO message_attachments(id, artifact_id, thread_id, comment_id, position, blob_hash, media_type, width, height, capture_json, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `image_${randomUUID().replaceAll("-", "")}`,
          artifactId,
          "threadId" in owner ? owner.threadId : null,
          "commentId" in owner ? owner.commentId : null,
          position,
          image.hash,
          image.mediaType,
          image.width,
          image.height,
          image.capture ? canonicalJson(image.capture) : null,
          purpose,
        );
    });
    return true;
  }

  operation(
    artifactId: string,
    input: Record<string, unknown>,
    kind: "threads" | "comment",
    parentId: string,
  ) {
    if (input.operationKey === undefined) return { replay: null, save: (_owner: Owner) => {} };
    const key = requireString(input.operationKey, "Operation key", 200);
    // Keep the original hashing namespace so retries survive the terminology upgrade.
    const hash = hashBytes(
      canonicalJson({ kind: kind === "threads" ? "feedback" : "reply", parentId, input }),
    );
    const row = this.db
      .query<
        { request_hash: string; thread_id: string | null; comment_id: string | null },
        [string, string]
      >("SELECT * FROM message_operations WHERE artifact_id = ? AND operation_key = ?")
      .get(artifactId, key);
    if (row && row.request_hash !== hash)
      throw new ArtifactError("Operation key was used for a different message", 409);
    return {
      replay: row ? (row.comment_id ?? row.thread_id) : null,
      save: (owner: Owner) =>
        this.db
          .query(
            "INSERT INTO message_operations(artifact_id, operation_key, request_hash, thread_id, comment_id) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            artifactId,
            key,
            hash,
            "threadId" in owner ? owner.threadId : null,
            "commentId" in owner ? owner.commentId : null,
          ),
    };
  }

  private capture(artifactId: string, value: unknown): AttachmentCapture {
    const input = requireObject(value, "Capture context");
    const versionSeq = requireSequence(input.versionSeq);
    const path = requireArtifactPath(input.path);
    if (
      !this.db
        .query(
          "SELECT 1 FROM version_files f JOIN artifact_versions v ON v.artifact_id = f.artifact_id AND v.seq = f.version_seq WHERE f.artifact_id = ? AND f.version_seq = ? AND f.path = ? AND v.published_at IS NOT NULL",
        )
        .get(artifactId, versionSeq, path)
    )
      throw new ArtifactError("Capture must name a published file in this artifact");
    const viewport = requireObject(input.viewport, "Capture viewport");
    const crop = requireObject(input.crop, "Capture crop");
    const number = (value: unknown, positive = true) => {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < (positive ? 1 : 0) ||
        value > 100_000
      )
        throw new ArtifactError("Invalid capture geometry");
      return value;
    };
    return {
      versionSeq,
      path,
      ...(input.route === undefined
        ? {}
        : { route: requireString(input.route, "Capture route", 4096) }),
      viewport: { width: number(viewport.width), height: number(viewport.height) },
      crop: {
        x: number(crop.x, false),
        y: number(crop.y, false),
        width: number(crop.width),
        height: number(crop.height),
      },
    };
  }
}
