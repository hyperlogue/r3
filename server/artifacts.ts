import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  Artifact,
  ArtifactActor,
  ArtifactFile,
  ArtifactKind,
  ArtifactProject,
  ArtifactState,
  ArtifactStorageUsage,
  ArtifactVersion,
} from "../shared/artifacts.ts";
import {
  ArtifactError,
  canonicalJson,
  jsonObject,
  optionalText,
  requireActor,
  requireArtifactPath,
  requireObject,
  requireSequence,
  requireString,
} from "./artifact-validation.ts";
import type { BlobStore } from "./blobs.ts";
import { nowIso } from "./ids.ts";
import {
  type DocumentRenderer,
  prepareFiles,
  type ValidatedPublication,
  validatePublication,
} from "./publication.ts";

type ArtifactRow = {
  id: string;
  kind: ArtifactKind;
  state: ArtifactState;
  project_id: string | null;
  title: string | null;
  meta_json: string;
  legacy_json: string | null;
  created_by: "human" | "agent";
  creator_session_id: string | null;
  next_seq: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  working: number;
  unhandled_count: number;
};

type VersionRow = {
  artifact_id: string;
  seq: number;
  kind: ArtifactKind;
  publication_key: string;
  content_hash: string;
  label: string | null;
  summary: string | null;
  published_by: "human" | "agent";
  publisher_session_id: string | null;
  provenance_json: string;
  entrypoint: "index.html" | "index.md" | null;
  file_count: number | null;
  patch_body: string | null;
  created_at: string;
  published_at: string;
};

const FILE_COLUMNS = `SELECT f.path, f.media_type AS mediaType,
  f.blob_hash AS hash, b.byte_length AS byteLength, f.rendered_blob_hash AS renderedHash,
  f.renderer_revision AS rendererRevision FROM version_files f JOIN blobs b ON b.hash = f.blob_hash
  WHERE f.artifact_id = ? AND f.version_seq = ?`;

function actor(role: "human" | "agent", sessionId: string | null): ArtifactActor {
  return role === "human" ? { role, sessionId: null } : { role, sessionId: sessionId! };
}

function versionFromRow(row: VersionRow): ArtifactVersion {
  const metadata = {
    artifactId: row.artifact_id,
    seq: row.seq,
    publicationKey: row.publication_key,
    contentHash: row.content_hash,
    label: row.label,
    summary: row.summary,
    publishedBy: actor(row.published_by, row.publisher_session_id),
    provenance: JSON.parse(row.provenance_json),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
  switch (row.kind) {
    case "files":
      return { ...metadata, kind: row.kind, entrypoint: null, fileCount: row.file_count! };
    case "html":
      return {
        ...metadata,
        kind: row.kind,
        entrypoint: row.entrypoint!,
        fileCount: row.file_count!,
      };
    case "diff":
      return { ...metadata, kind: row.kind, entrypoint: null, fileCount: null };
  }
}

export interface ArtifactFilter {
  state?: ArtifactState;
  kind?: ArtifactKind;
  projectId?: string;
  meta?: Record<string, string>;
}

// Owns publication visibility. Callers inject the store and renderer; importing
// this module never opens a database or resolves a publisher's working tree.
// The supplied connection has the artifact schema and foreign_keys enabled.
export class ArtifactStore {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
    private readonly renderDocument: DocumentRenderer,
    private readonly clock: () => string = nowIso,
    private readonly isWatching: (id: string) => boolean = () => false,
  ) {}

  registerSession(value: unknown): AgentSession {
    const body = requireObject(value, "Agent session");
    const id =
      body.id === undefined ? `agent_${randomUUID()}` : requireString(body.id, "Session id", 200);
    const harness = optionalText(body.harness, "harness", 200);
    const label = optionalText(body.label, "label", 1000);
    const existing = this.db
      .query<AgentSession, [string]>(
        "SELECT id, harness, label, created_at AS createdAt FROM agent_sessions WHERE id = ?",
      )
      .get(id);
    if (existing) {
      if (
        (body.harness !== undefined && existing.harness !== harness) ||
        (body.label !== undefined && existing.label !== label)
      ) {
        throw new ArtifactError("Agent session is already registered with different metadata", 409);
      }
      return existing;
    }
    const createdAt = this.clock();
    this.db
      .query("INSERT INTO agent_sessions(id, harness, label, created_at) VALUES (?, ?, ?, ?)")
      .run(id, harness, label, createdAt);
    return { id, harness, label, createdAt };
  }

  sessions(): AgentSession[] {
    return this.db
      .query<AgentSession, []>(
        "SELECT id, harness, label, created_at AS createdAt FROM agent_sessions ORDER BY created_at, id",
      )
      .all();
  }

  projects(): ArtifactProject[] {
    return this.db
      .query<ArtifactProject, []>(
        "SELECT id, name, remote_url AS remoteUrl, created_at AS createdAt FROM projects ORDER BY name, id",
      )
      .all();
  }

  createProject(value: unknown): ArtifactProject {
    const input = requireObject(value, "Project");
    const id =
      input.id === undefined
        ? `project_${randomUUID()}`
        : requireString(input.id, "Project id", 200);
    const name = optionalText(input.name, "Project name", 1000);
    const remoteUrl = optionalText(input.remoteUrl, "Project remote", 4096);
    if (this.db.query("SELECT 1 FROM projects WHERE id = ?").get(id))
      throw new ArtifactError("Project id is already registered", 409);
    const createdAt = this.clock();
    this.db
      .query("INSERT INTO projects(id, name, remote_url, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, remoteUrl, createdAt);
    return { id, name, remoteUrl, createdAt };
  }

  deleteProject(id: string): void {
    if (!this.db.query("DELETE FROM projects WHERE id = ?").run(id).changes)
      throw new ArtifactError("Project not found", 404);
  }

  viewed(id: string): string[] {
    this.get(id);
    return this.db
      .query<{ key: string }, [string]>(
        "SELECT key FROM viewed_marks WHERE artifact_id = ? ORDER BY key",
      )
      .all(id)
      .map((row) => row.key);
  }

  setViewed(id: string, value: unknown): void {
    this.get(id);
    const input = requireObject(value, "Viewed mark");
    const key = requireString(input.key, "Viewed key", 8192);
    if (typeof input.viewed !== "boolean")
      throw new ArtifactError("Viewed mark requires a boolean viewed value");
    if (input.viewed)
      this.db
        .query("INSERT INTO viewed_marks(artifact_id, key) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .run(id, key);
    else this.db.query("DELETE FROM viewed_marks WHERE artifact_id = ? AND key = ?").run(id, key);
  }

  validateActor(value: unknown): ArtifactActor {
    const author = requireActor(value);
    if (
      author.role === "agent" &&
      !this.db.query("SELECT 1 FROM agent_sessions WHERE id = ?").get(author.sessionId)
    ) {
      throw new ArtifactError("Register the agent session before writing as that agent");
    }
    return author;
  }

  create(value: unknown): Artifact {
    const body = requireObject(value, "Artifact");
    if (body.kind !== "files" && body.kind !== "html" && body.kind !== "diff") {
      throw new ArtifactError("Artifact kind must be files, html, or diff");
    }
    const author = this.validateActor(body.actor);
    const title = optionalText(body.title, "title", 1000);
    if ("summary" in body)
      throw new ArtifactError("Artifact overview was removed; publish a version summary instead");
    const projectId = optionalText(body.projectId, "projectId", 200);
    if (
      projectId !== null &&
      !this.db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)
    ) {
      throw new ArtifactError("Unknown project");
    }
    const meta = jsonObject(body.meta === undefined ? {} : body.meta, "meta");
    if (Object.values(meta).some((value) => typeof value !== "string")) {
      throw new ArtifactError("Artifact metadata values must be strings");
    }
    const id = `artifact_${randomUUID().replaceAll("-", "")}`;
    const time = this.clock();
    this.db
      .query(`INSERT INTO artifacts
      (id, kind, project_id, title, meta_json, created_by, creator_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        body.kind,
        projectId,
        title,
        canonicalJson(meta),
        author.role,
        author.sessionId,
        time,
        time,
      );
    return this.get(id);
  }

  get(id: string): Artifact {
    const row = this.db
      .query<ArtifactRow, [string, string]>(`SELECT a.*, EXISTS (
      SELECT 1 FROM feedback f JOIN feedback_claims c ON c.feedback_id = f.id
      WHERE f.artifact_id = a.id AND c.expires_at > ?
    ) AS working, (
      SELECT count(*) FROM feedback f WHERE f.artifact_id = a.id AND f.status = 'open'
      AND COALESCE((SELECT r.author FROM replies r WHERE r.feedback_id = f.id
        ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1), f.author) = 'agent'
    ) AS unhandled_count FROM artifacts a WHERE a.id = ?`)
      .get(this.clock(), id);
    if (!row) throw new ArtifactError("Artifact not found", 404);
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      projectId: row.project_id,
      title: row.title,
      meta: JSON.parse(row.meta_json),
      createdBy: actor(row.created_by, row.creator_session_id),
      nextSeq: row.next_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      watching: this.isWatching(id),
      working: !!row.working,
      unhandledCount: row.unhandled_count,
      storage: this.storageUsage(id),
      legacy: row.legacy_json === null ? null : JSON.parse(row.legacy_json),
    };
  }

  private storageUsage(id: string): ArtifactStorageUsage {
    // Read committed membership and blob lengths only; never open file bytes.
    // The last reference identifies hashes present in the latest publication,
    // even when the same bytes appear under multiple paths or representations.
    return this.db
      .query<ArtifactStorageUsage, [string, string]>(`WITH published AS (
        SELECT seq, patch_body FROM artifact_versions
        WHERE artifact_id = ? AND published_at IS NOT NULL
      ), files AS (
        SELECT f.* FROM version_files f JOIN published p ON p.seq = f.version_seq
        WHERE f.artifact_id = ?
      ), references_by_hash AS (
        SELECT hash, MAX(seq) AS last_seq FROM (
          SELECT blob_hash AS hash, version_seq AS seq FROM files
          UNION ALL
          SELECT rendered_blob_hash, version_seq FROM files WHERE rendered_blob_hash IS NOT NULL
        ) GROUP BY hash
      ), sizes AS (
        SELECT b.byte_length, r.last_seq FROM references_by_hash r JOIN blobs b ON b.hash = r.hash
        UNION ALL
        SELECT length(CAST(patch_body AS BLOB)), seq FROM published WHERE patch_body IS NOT NULL
      ) SELECT COALESCE(SUM(byte_length), 0) AS totalBytes,
        COALESCE(SUM(CASE WHEN last_seq = (SELECT MAX(seq) FROM published)
          THEN byte_length ELSE 0 END), 0) AS latestVersionBytes FROM sizes`)
      .get(id, id)!;
  }

  list(filter: ArtifactFilter = {}): Artifact[] {
    const clauses: string[] = [];
    const args: string[] = [];
    for (const [column, value] of [
      ["state", filter.state],
      ["kind", filter.kind],
      ["project_id", filter.projectId],
    ]) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        args.push(value);
      }
    }
    for (const [key, value] of Object.entries(filter.meta ?? {})) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(meta_json) WHERE key = ? AND value = ?)");
      args.push(key, value);
    }
    return this.db
      .query<{ id: string }, string[]>(
        `SELECT id FROM artifacts ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, id`,
      )
      .all(...args)
      .map(({ id }) => this.get(id));
  }

  edit(id: string, value: unknown): Artifact {
    const current = this.get(id);
    const body = requireObject(value, "Artifact edit");
    const title =
      body.title === undefined ? current.title : optionalText(body.title, "title", 1000);
    if ("summary" in body)
      throw new ArtifactError("Artifact overview was removed; publish a version summary instead");
    const meta = body.meta === undefined ? current.meta : jsonObject(body.meta, "meta");
    if (Object.values(meta).some((value) => typeof value !== "string"))
      throw new ArtifactError("Artifact metadata values must be strings");
    this.db
      .query("UPDATE artifacts SET title = ?, meta_json = ?, updated_at = ? WHERE id = ?")
      .run(title, canonicalJson(meta), this.clock(), id);
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    // Includes the deferred HTML entrypoint cycle and every owned conversation
    // record. Blob reclamation is coordinated separately, after references go.
    this.db
      .transaction(() => this.db.query("DELETE FROM artifacts WHERE id = ?").run(id))
      .immediate();
  }

  versions(id: string): ArtifactVersion[] {
    this.get(id);
    return this.db
      .query<VersionRow, [string]>(
        "SELECT * FROM artifact_versions WHERE artifact_id = ? AND published_at IS NOT NULL ORDER BY seq",
      )
      .all(id)
      .map(versionFromRow);
  }

  private versionRow(id: string, seq: number): VersionRow {
    requireSequence(seq);
    const row = this.db
      .query<VersionRow, [string, number]>(
        "SELECT * FROM artifact_versions WHERE artifact_id = ? AND seq = ? AND published_at IS NOT NULL",
      )
      .get(id, seq);
    if (!row) throw new ArtifactError("Published version not found", 404);
    return row;
  }

  version(id: string, seq: number): ArtifactVersion {
    return versionFromRow(this.versionRow(id, seq));
  }

  private retry(id: string, publication: ValidatedPublication): ArtifactVersion | null {
    const row = this.db
      .query<VersionRow, [string, string]>(
        "SELECT * FROM artifact_versions WHERE artifact_id = ? AND publication_key = ? AND published_at IS NOT NULL",
      )
      .get(id, publication.publicationKey);
    if (!row) return null;
    if (
      row.content_hash !== publication.contentHash ||
      row.label !== publication.label ||
      row.summary !== publication.summary ||
      row.published_by !== publication.actor.role ||
      row.publisher_session_id !== publication.actor.sessionId ||
      canonicalJson(JSON.parse(row.provenance_json)) !== canonicalJson(publication.provenance)
    ) {
      throw new ArtifactError(
        "Publication key was already used for different content or metadata",
        409,
      );
    }
    return versionFromRow(row);
  }

  private publicationGate(id: string, publication: ValidatedPublication): Artifact {
    const artifact = this.get(id);
    if (artifact.kind !== publication.kind)
      throw new ArtifactError("Publication kind must match the artifact");
    if (artifact.state !== "active") throw new ArtifactError("Artifact is archived", 409);
    const latest = this.db
      .query<{ seq: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM artifact_versions WHERE artifact_id = ? AND published_at IS NOT NULL",
      )
      .get(id)!.seq;
    if (latest !== publication.expectedSeq)
      throw new ArtifactError(`Publication conflict: latest version is ${latest}`, 409);
    return artifact;
  }

  async publish(id: string, value: unknown): Promise<ArtifactVersion> {
    return this.blobs.publishing(() => this.publishHeld(id, value));
  }

  private async publishHeld(id: string, value: unknown): Promise<ArtifactVersion> {
    const publication = validatePublication(value);
    this.validateActor(publication.actor);
    this.get(id);
    const previous = this.retry(id, publication);
    if (previous) return previous;
    this.publicationGate(id, publication);
    const files = await prepareFiles(publication, this.blobs, this.renderDocument);
    return this.db
      .transaction(() => {
        // State and expected sequence may have changed during preparation. A retry
        // also may have completed while this upload was rendering its documents.
        const previous = this.retry(id, publication);
        if (previous) return previous;
        const artifact = this.publicationGate(id, publication);
        const seq = artifact.nextSeq;
        if (!Number.isSafeInteger(seq + 1))
          throw new ArtifactError("Version sequence exhausted", 409);
        const time = this.clock();
        this.db
          .query("UPDATE artifacts SET next_seq = ?, updated_at = ? WHERE id = ?")
          .run(seq + 1, time, id);
        this.db
          .query(`INSERT INTO artifact_versions
        (artifact_id, seq, kind, publication_key, content_hash, label, summary, published_by,
         publisher_session_id, provenance_json, entrypoint, patch_body, file_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            id,
            seq,
            publication.kind,
            publication.publicationKey,
            publication.contentHash,
            publication.label,
            publication.summary,
            publication.actor.role,
            publication.actor.sessionId,
            canonicalJson(publication.provenance),
            publication.entrypoint,
            publication.patch,
            publication.kind === "diff" ? null : files.length,
            time,
          );
        for (const file of files) {
          for (const blob of [file, file.rendered]) {
            if (blob)
              this.db
                .query(
                  "INSERT INTO blobs(hash, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING",
                )
                .run(blob.hash, blob.byteLength, time);
          }
          this.db
            .query(`INSERT INTO version_files
          (artifact_id, version_seq, artifact_kind, path, media_type, blob_hash, rendered_blob_hash, renderer_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              id,
              seq,
              publication.kind,
              file.path,
              file.mediaType,
              file.hash,
              file.rendered?.hash ?? null,
              file.rendered?.revision ?? null,
            );
        }
        this.db
          .query("UPDATE artifact_versions SET published_at = ? WHERE artifact_id = ? AND seq = ?")
          .run(time, id, seq);
        return this.version(id, seq);
      })
      .immediate();
  }

  files(id: string, seq: number): ArtifactFile[] {
    if (this.versionRow(id, seq).kind === "diff")
      throw new ArtifactError("Diff versions contain a patch, not files");
    return this.db
      .query<ArtifactFile, [string, number]>(`${FILE_COLUMNS} ORDER BY f.path`)
      .all(id, seq);
  }

  file(id: string, seq: number, path: string): ArtifactFile {
    requireArtifactPath(path);
    this.versionRow(id, seq);
    const file = this.db
      .query<ArtifactFile, [string, number, string]>(`${FILE_COLUMNS} AND f.path = ?`)
      .get(id, seq, path);
    if (!file) throw new ArtifactError("File is absent from this version", 404);
    return file;
  }

  async readFile(id: string, seq: number, path: string, rendered = false): Promise<Buffer> {
    const file = this.file(id, seq, path);
    if (rendered && !file.renderedHash)
      throw new ArtifactError("File has no retained document rendering", 404);
    return this.blobs.read(rendered ? file.renderedHash! : file.hash);
  }

  resource(id: string, seq: number, path: string, rendered = false) {
    const file = this.file(id, seq, path);
    if (rendered && !file.renderedHash && file.mediaType.split(";")[0] !== "text/html") {
      throw new ArtifactError("File has no rendered document representation", 404);
    }
    const hash = rendered ? (file.renderedHash ?? file.hash) : file.hash;
    const length = this.db
      .query<{ byte_length: number }, [string]>("SELECT byte_length FROM blobs WHERE hash = ?")
      .get(hash);
    if (!length) throw new Error("Published resource is missing its blob metadata");
    return {
      hash,
      byteLength: length.byte_length,
      mediaType: rendered ? "text/html; charset=utf-8" : file.mediaType,
      read: () => this.blobs.read(hash),
    };
  }

  patch(id: string, seq: number): string {
    const row = this.versionRow(id, seq);
    if (row.kind !== "diff") throw new ArtifactError("Only diff versions contain patches");
    return row.patch_body!;
  }
}
