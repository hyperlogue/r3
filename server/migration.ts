import type { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { ARTIFACT_SCHEMA_VERSION, createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import type { BlobStore } from "./blobs.ts";
import { nowIso } from "./ids.ts";
import { importLegacyContent, type LegacyCapture } from "./migration-content.ts";
import { importLegacyConversations } from "./migration-conversations.ts";
import {
  LEGACY_TABLES,
  type LegacyData,
  type LegacyTable,
  legacyId,
  MigrationContext,
  readLegacyData,
  sqlName,
} from "./migration-data.ts";
import type { DocumentRenderer } from "./publication.ts";

export interface LegacyMigrationOptions {
  // Must be a new file in an owner-only directory supplied by store bootstrap.
  backupPath: string;
  blobs: BlobStore;
  render: DocumentRenderer;
  capture?: LegacyCapture;
  clock?: () => string;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  artifactCount: number;
  backupPath: string | null;
}

function dataVersion(db: Database): number {
  return db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
}

function checkLegacyRelations(data: LegacyData): void {
  const reviews = new Map(data.reviews.map((row) => [legacyId(row.id), row]));
  for (const table of ["patches", "snapshots", "feedback", "viewed_marks"] as const) {
    for (const row of data[table]) {
      const review = reviews.get(legacyId(row.review_id));
      if (!review) throw new Error(`Legacy ${table} record has no owning review`);
      if (table === "patches" && review.kind !== "diff")
        throw new Error("Legacy patch belongs to a non-diff review");
      if (table === "snapshots" && review.kind === "diff")
        throw new Error("Legacy snapshot belongs to a diff review");
    }
  }
  const snapshots = new Set(data.snapshots.map((row) => JSON.stringify([row.review_id, row.seq])));
  for (const row of data.snapshot_files) {
    if (!snapshots.has(JSON.stringify([row.review_id, row.seq])))
      throw new Error("Legacy file has no owning snapshot");
  }
  const feedback = new Set(data.feedback.map((row) => legacyId(row.id)));
  for (const table of ["replies", "feedback_claims"] as const) {
    for (const row of data[table]) {
      if (!feedback.has(legacyId(row.feedback_id)))
        throw new Error(`Legacy ${table} record has no owning feedback`);
    }
  }
}

function importAuxiliary(context: MigrationContext, store: ArtifactStore): void {
  const { db, data } = context;
  // Credentials stay hashed, and the cookie/token contract is unchanged. Do
  // not copy arbitrary extra legacy columns into a new credential record.
  for (const [table, columns] of [
    ["auth_tokens", ["id", "label", "token_hash", "created_at", "last_used_at", "revoked_at"]],
    ["auth_sessions", ["id", "token_id", "session_hash", "created_at", "expires_at"]],
  ] as const) {
    const insert = db.query(
      `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of data[table]) insert.run(...columns.map((column) => row[column] ?? null));
  }
  for (const row of data.viewed_marks) {
    const id = legacyId(row.review_id);
    const key = legacyId(row.key);
    const keys = new Set([key]);
    if (key.startsWith("f:")) {
      // Only translate a content mark when the old digest identifies surviving
      // bytes. Keep the original opaque key too, including unavailable history.
      for (const file of data.snapshot_files) {
        if (file.review_id !== id || file.skipped === 1 || key !== `f:${file.path}@${file.sha}`)
          continue;
        const current = store.file(id, Number(file.seq), String(file.path));
        keys.add(`f:${file.path}@${current.hash}`);
      }
    }
    for (const key of keys)
      db.query(
        "INSERT INTO viewed_marks(artifact_id, key) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ).run(id, key);
  }
}

// Startup owns this connection exclusively until the promise resolves. The
// explicit transaction spans async byte preparation; no request handler may
// observe it. A failure or process crash rolls back both schema and data. Blobs
// installed before a rollback are unreferenced and reclaimed by startup GC.
export async function migrateLegacyStore(
  db: Database,
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationResult> {
  if (db.inTransaction)
    throw new Error("Migration needs exclusive ownership of the database connection");
  const schemaVersion = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  if (schemaVersion > ARTIFACT_SCHEMA_VERSION)
    throw new Error("This artifact store requires a newer r3 binary");
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name);
  if (
    schemaVersion === ARTIFACT_SCHEMA_VERSION &&
    tables.includes("artifacts") &&
    !tables.includes("reviews")
  ) {
    return {
      migrated: false,
      artifactCount: db.query<{ n: number }, []>("SELECT count(*) AS n FROM artifacts").get()!.n,
      backupPath: null,
    };
  }
  if (
    schemaVersion !== 0 ||
    !tables.includes("reviews") ||
    tables.some((name) => !LEGACY_TABLES.includes(name as LegacyTable))
  ) {
    throw new Error("Unrecognized store schema; migration did not modify it");
  }
  db.exec("PRAGMA foreign_keys = ON");
  const beforeBackup = dataVersion(db);
  // Reserve an empty private file before SQLite writes the consistent backup;
  // VACUUM INTO accepts an empty existing file, but never overwrites a backup.
  const backup = await open(options.backupPath, "wx", 0o600);
  try {
    db.query("VACUUM main INTO ?").run(options.backupPath);
    await backup.sync();
  } finally {
    await backup.close();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (dataVersion(db) !== beforeBackup)
      throw new Error(
        "Legacy store changed while backing up; retry migration after stopping its writer",
      );
    const data = readLegacyData(db);
    checkLegacyRelations(data);
    const context = new MigrationContext(db, data, (options.clock ?? nowIso)());
    // Remove named legacy indexes/triggers before creating destination objects.
    // Autoindexes belong to their renamed table and need no manual changes.
    for (const object of db
      .query<{ type: string; name: string }, []>(
        "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL",
      )
      .all())
      db.exec(`DROP ${object.type === "index" ? "INDEX" : "TRIGGER"} ${sqlName(object.name)}`);
    for (const table of tables)
      db.exec(`ALTER TABLE ${sqlName(table)} RENAME TO ${sqlName(`legacy_${table}`)}`);
    createArtifactTables(db);
    const store = new ArtifactStore(db, options.blobs, options.render, () => context.time);
    await importLegacyContent(context, options.blobs, options.render, options.capture);
    await importLegacyConversations(context, store);
    importAuxiliary(context, store);
    // Children first: avoid cascades while removing the old schema, and retain
    // the destination's independent FK graph throughout the transaction.
    for (const table of [
      "auth_sessions",
      "auth_tokens",
      "feedback_claims",
      "replies",
      "feedback",
      "snapshot_files",
      "snapshots",
      "patches",
      "viewed_marks",
      "reviews",
      "repos",
    ]) {
      if (tables.includes(table)) db.exec(`DROP TABLE ${sqlName(`legacy_${table}`)}`);
    }
    if (db.query("PRAGMA foreign_key_check").all().length)
      throw new Error("Migrated references failed the foreign-key check");
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      throw new Error("Migrated store failed the integrity check");
    db.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    return { migrated: true, artifactCount: data.reviews.length, backupPath: options.backupPath };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
