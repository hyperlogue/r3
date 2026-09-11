import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { renderArtifactDocument } from "./artifact-document.ts";
import { ArtifactLifecycle } from "./artifact-lifecycle.ts";
import { ARTIFACT_SCHEMA_VERSION, createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AuthService } from "./auth.ts";
import { BlobStore } from "./blobs.ts";
import { nowIso } from "./ids.ts";
import { type LegacyMigrationResult, migrateLegacyStore } from "./migration.ts";
import { legacyLocalCapture } from "./migration-capture.ts";
import type { LegacyCapture } from "./migration-content.ts";
import type { DocumentRenderer } from "./publication.ts";

export interface ArtifactStorageOptions {
  databasePath: string;
  contentRoot?: string;
  render?: DocumentRenderer;
  capture?: LegacyCapture;
  clock?: () => string;
  isWatching?: (id: string) => boolean;
}

export interface ArtifactStorage {
  artifacts: ArtifactStore;
  conversations: ArtifactConversations;
  lifecycle: ArtifactLifecycle;
  authentication: AuthService;
  migration: LegacyMigrationResult | null;
  collectBlobs(): Promise<number>;
  // The caller stops accepting requests before closing storage.
  close(): void;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory())
    throw new Error("Artifact storage must be a real directory");
  await chmod(path, 0o700);
}

// Owns the connection and upgrade boundary. Importing this module opens no
// database; bootstrap must hold the daemon's process lock before calling it.
export async function openArtifactStorage(
  options: ArtifactStorageOptions,
): Promise<ArtifactStorage> {
  const { databasePath } = options;
  const root = options.contentRoot ?? `${databasePath}.artifacts`;
  const clock = options.clock ?? nowIso;
  const render = options.render ?? renderArtifactDocument;
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  // Create the main file privately before SQLite can create WAL/SHM files from
  // its permissions. Never chmod a caller's existing parent directory.
  const handle = await open(
    databasePath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Artifact database must be a regular file");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await privateDirectory(root);
  const blobs = new BlobStore(join(root, "blobs"));
  const db = new Database(databasePath);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const schemaVersion = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    let migration: LegacyMigrationResult | null = null;
    if (!tables.length && schemaVersion === 0) {
      db.transaction(() => {
        createArtifactTables(db);
        db.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION}`);
      }).immediate();
    } else {
      const backupRoot = join(root, "backups");
      await privateDirectory(backupRoot);
      migration = await migrateLegacyStore(db, {
        backupPath: join(backupRoot, `legacy-${randomUUID()}.sqlite`),
        blobs,
        render,
        clock,
        capture:
          options.capture ??
          legacyLocalCapture({
            scratchRoot: join(dirname(databasePath), "scratch"),
            docsRoot: join(dirname(databasePath), "docs"),
          }),
      });
    }
    const artifacts = new ArtifactStore(db, blobs, render, clock, options.isWatching);
    const conversations = new ArtifactConversations(db, artifacts, clock);
    const authentication = new AuthService(db, clock);
    async function collectBlobs(): Promise<number> {
      const removed = await blobs.collect(
        () =>
          new Set(
            db
              .query<{ hash: string }, []>(
                "SELECT blob_hash AS hash FROM version_files UNION SELECT rendered_blob_hash AS hash FROM version_files WHERE rendered_blob_hash IS NOT NULL",
              )
              .all()
              .map((row) => row.hash),
          ),
      );
      db.exec(`DELETE FROM blobs WHERE NOT EXISTS (
        SELECT 1 FROM version_files WHERE blob_hash = blobs.hash OR rendered_blob_hash = blobs.hash
      )`);
      return removed;
    }
    await collectBlobs();
    conversations.expireClaims();
    authentication.expireSessions();
    return {
      artifacts,
      conversations,
      authentication,
      lifecycle: new ArtifactLifecycle(db, artifacts, clock),
      migration,
      collectBlobs,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
