import type { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { ATTACHMENT_SCHEMA } from "./artifact-attachments.ts";
import { ARTIFACT_LISTENER_SCHEMA } from "./artifact-listeners.ts";
import { ARTIFACT_SCHEMA_VERSION, PROJECT_REMOTE_SCHEMA } from "./artifact-schema.ts";
import { ARTIFACT_SEARCH_SCHEMA } from "./artifact-search-schema.ts";
import { installArtifactUsage } from "./artifact-usage-schema.ts";
import { nowIso } from "./ids.ts";

export interface ArtifactMigrationOptions {
  // Must be a new file in an owner-only directory supplied by store bootstrap.
  backupPath: string;
  clock?: () => string;
}

export interface ArtifactMigrationResult {
  migrated: boolean;
  artifactCount: number;
  backupPath: string | null;
}

function dataVersion(db: Database): number {
  return db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
}

// Startup owns this connection exclusively until the promise resolves. The
// upgrade transaction is private to startup. A failure or process crash rolls
// back schema and data; a private backup retains the previous database.
export async function upgradeArtifactStore(
  db: Database,
  options: ArtifactMigrationOptions,
): Promise<ArtifactMigrationResult> {
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
  if (tables.includes("reviews"))
    throw new Error("Upgrade live-review stores with r3 1.5.0 before opening them here");
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(schemaVersion) || !tables.includes("artifacts"))
    throw new Error("Unrecognized store schema; migration did not modify it");
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
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    if (dataVersion(db) !== beforeBackup)
      throw new Error(
        "Artifact store changed while backing up; retry migration after stopping its writer",
      );
    if (schemaVersion === 1) {
      db.exec(`UPDATE artifacts SET legacy_json = json_set(COALESCE(legacy_json, '{}'), '$.retiredOverview', summary) WHERE summary IS NOT NULL;
        ALTER TABLE artifacts DROP COLUMN summary;`);
    }
    db.exec(PROJECT_REMOTE_SCHEMA);
    db.exec(ARTIFACT_LISTENER_SCHEMA);
    // Older edits erased sent_at, so a null stamp cannot prove no delivery.
    // Prefer an extra future status notification over silently dropping one.
    if (schemaVersion < 5)
      db.exec(`ALTER TABLE feedback ADD COLUMN ever_delivered INTEGER NOT NULL DEFAULT 0
      CHECK (ever_delivered IN (0, 1));
      UPDATE feedback SET ever_delivered = 1;`);
    if (schemaVersion < 6)
      db.exec(`ALTER TABLE artifacts ADD COLUMN feedback_revision INTEGER NOT NULL DEFAULT 0
      CHECK (feedback_revision >= 0);`);
    // Rebuild constrained target tables without changing their native evidence.
    // The connection is private during migration and references are checked below.
    for (const table of ["feedback", "replies", "feedback_placements"]) {
      const schema = db
        .query<{ sql: string }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table)!.sql;
      const next = schema.replaceAll("'source', 'rendered'", "'source', 'rendered', 'media'");
      if (next === schema || schema.includes("'media'")) continue;
      const objects = db
        .query<{ name: string; type: string; sql: string }, [string]>(
          "SELECT name, type, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
        )
        .all(table);
      db.exec(next.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_media_upgrade`));
      db.exec(`INSERT INTO ${table}_media_upgrade SELECT * FROM ${table}`);
      for (const object of objects) {
        if (object.type === "trigger")
          db.exec(`DROP TRIGGER "${object.name.replaceAll('"', '""')}"`);
      }
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_media_upgrade RENAME TO ${table}`);
      for (const object of objects) db.exec(object.sql);
    }
    if (
      tables.includes("message_attachments") &&
      !db
        .query<{ name: string }, []>("PRAGMA table_info(message_attachments)")
        .all()
        .some((column) => column.name === "purpose")
    ) {
      db.exec(
        "ALTER TABLE message_attachments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'message' CHECK (purpose IN ('message', 'target'))",
      );
      db.exec("DROP TRIGGER IF EXISTS immutable_message_attachment");
    }
    db.exec(ATTACHMENT_SCHEMA);
    db.exec(ARTIFACT_SEARCH_SCHEMA);
    installArtifactUsage(db, (options.clock ?? nowIso)());
    if (db.query("PRAGMA foreign_key_check").all().length)
      throw new Error("Migrated references failed the foreign-key check");
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      throw new Error("Migrated store failed the integrity check");
    db.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    return {
      migrated: true,
      artifactCount: db.query<{ n: number }, []>("SELECT count(*) AS n FROM artifacts").get()!.n,
      backupPath: options.backupPath,
    };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
