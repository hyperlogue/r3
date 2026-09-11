import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { ARTIFACT_SCHEMA_VERSION } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AuthService } from "./auth.ts";
import { BlobStore } from "./blobs.ts";
import { migrateLegacyStore } from "./migration.ts";

let root: string;
let db: Database;
let blobs: BlobStore;
const time = "2026-09-01T00:00:00.000Z";
const render = async (source: string) => ({
  html: `<article>${source}</article>`,
  revision: "migration-test",
});

function fixture(database: Database): void {
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE repos(id TEXT PRIMARY KEY, common_dir TEXT, name TEXT, remote TEXT, created_at TEXT);
    CREATE TABLE reviews(id TEXT PRIMARY KEY, repo_id TEXT REFERENCES repos(id), kind TEXT,
      title TEXT, status TEXT, source TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE snapshots(review_id TEXT REFERENCES reviews(id), seq INTEGER, label TEXT, created_at TEXT, PRIMARY KEY(review_id, seq));
    CREATE TABLE snapshot_files(review_id TEXT, seq INTEGER, path TEXT, content TEXT, sha TEXT, skipped INTEGER,
      FOREIGN KEY(review_id, seq) REFERENCES snapshots(review_id, seq));
    CREATE TABLE feedback(id TEXT PRIMARY KEY, review_id TEXT REFERENCES reviews(id), author TEXT,
      file TEXT, body TEXT, status TEXT, created_at TEXT, updated_at TEXT, sent_at TEXT);
    CREATE TABLE replies(id TEXT PRIMARY KEY, feedback_id TEXT REFERENCES feedback(id), author TEXT, body TEXT, created_at TEXT, ref_version INTEGER);
    CREATE INDEX replies_by_feedback ON replies(feedback_id);
    CREATE TABLE viewed_marks(review_id TEXT REFERENCES reviews(id), key TEXT);
    CREATE TABLE auth_tokens(id TEXT PRIMARY KEY, label TEXT, token_hash TEXT UNIQUE, created_at TEXT, last_used_at TEXT, revoked_at TEXT);
    CREATE TABLE auth_sessions(id TEXT PRIMARY KEY, token_id TEXT REFERENCES auth_tokens(id), session_hash TEXT UNIQUE, created_at TEXT, expires_at TEXT);
    CREATE INDEX sessions_by_token ON auth_sessions(token_id);
    INSERT INTO repos VALUES ('repo_example', '/path/to/repo/.git', 'Example', NULL, NULL);
    INSERT INTO reviews VALUES ('review_retained', 'repo_example', 'files', 'Retained work', 'open', '{}', NULL, NULL, NULL);
    INSERT INTO snapshots VALUES ('review_retained', 2, 'Original', NULL);
    INSERT INTO snapshot_files VALUES ('review_retained', 2, 'index.md', '# Kept', 'legacy-digest', NULL);
    INSERT INTO feedback VALUES ('feedback_retained', 'review_retained', 'human', '', 'Keep the thread', 'open', NULL, NULL, NULL);
    INSERT INTO replies VALUES ('reply_retained', 'feedback_retained', 'agent', 'Keep the answer', NULL, 2);
    INSERT INTO viewed_marks VALUES ('review_retained', 'f:index.md@legacy-digest');
  `);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-migration-"));
  db = new Database(join(root, "store.sqlite"));
  fixture(db);
  blobs = new BlobStore(join(root, "blobs"));
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
function options(name = "backup.sqlite") {
  return { backupPath: join(root, name), blobs, render, clock: () => time };
}

describe("atomic legacy store migration", () => {
  test("preserves identity, bytes, threads, read progress and login state across reopen", async () => {
    const auth = new AuthService(db, () => time);
    const token = auth.createLoginToken("Migration test");
    const session = auth.mintSession(token.info.id);
    const result = await migrateLegacyStore(db, options());
    expect(result).toMatchObject({ migrated: true, artifactCount: 1 });
    expect((await stat(options().backupPath)).mode & 0o777).toBe(0o600);
    const backup = new Database(options().backupPath, { readonly: true });
    expect(backup.query("SELECT id FROM reviews").all()).toEqual([{ id: "review_retained" }]);
    expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    db.close();
    db = new Database(join(root, "store.sqlite"));
    db.exec("PRAGMA foreign_keys = ON");
    const store = new ArtifactStore(db, blobs, render, () => time);
    const threads = new ArtifactConversations(db, store, () => time);
    expect((await store.readFile("review_retained", 2, "index.md")).toString()).toBe("# Kept");
    expect(threads.get("feedback_retained").replies[0].id).toBe("reply_retained");
    expect(new AuthService(db, () => time).sessionValid(session.cookieValue)).toBe(true);
    expect(new AuthService(db, () => time).verifyLogin(token.token)).toEqual({
      tokenId: token.info.id,
    });
    const hash = store.file("review_retained", 2, "index.md").hash;
    expect(db.query("SELECT key FROM viewed_marks ORDER BY key").all()).toContainEqual({
      key: `f:index.md@${hash}`,
    });
    expect(db.query("PRAGMA user_version").get()).toEqual({
      user_version: ARTIFACT_SCHEMA_VERSION,
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE name LIKE 'legacy_%' OR name = 'reviews'")
        .all(),
    ).toEqual([]);
    expect(await migrateLegacyStore(db, options())).toMatchObject({
      migrated: false,
      backupPath: null,
    });
  });

  test("preparation failure rolls back the old schema, rows and named indexes, then permits retry", async () => {
    await expect(
      migrateLegacyStore(db, {
        ...options(),
        render: async () => {
          throw new Error("Renderer failed");
        },
      }),
    ).rejects.toThrow("Renderer failed");
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT body FROM replies").all()).toEqual([{ body: "Keep the answer" }]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name = 'replies_by_feedback'").all(),
    ).toHaveLength(1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'artifacts'").all()).toEqual([]);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    await expect(migrateLegacyStore(db, options())).rejects.toThrow();
    expect((await migrateLegacyStore(db, options("retry.sqlite"))).migrated).toBe(true);
  });

  test("does not discard orphaned content or mutate an unrecognized schema", async () => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("INSERT INTO snapshot_files VALUES (?, ?, ?, ?, ?, NULL)").run(
      "missing_review",
      1,
      "lost.txt",
      "Must not disappear",
      "old",
    );
    await expect(migrateLegacyStore(db, options())).rejects.toThrow("no owning snapshot");
    expect(
      db.query("SELECT content FROM snapshot_files WHERE review_id = 'missing_review'").get(),
    ).toEqual({ content: "Must not disappear" });
    db.exec("CREATE TABLE unexpected_store(value TEXT)");
    await expect(migrateLegacyStore(db, options("unknown.sqlite"))).rejects.toThrow(
      "Unrecognized store schema",
    );
    expect(await Bun.file(join(root, "unknown.sqlite")).exists()).toBe(false);
  });

  test("a process killed during preparation leaves the legacy WAL store restartable", async () => {
    db.close();
    const script = `
      import { Database } from "bun:sqlite";
      const { migrateLegacyStore } = await import(process.env.R3_TEST_MIGRATION);
      const { BlobStore } = await import(process.env.R3_TEST_BLOBS);
      const db = new Database(process.env.R3_TEST_DB);
      await migrateLegacyStore(db, {
        backupPath: process.env.R3_TEST_BACKUP,
        blobs: new BlobStore(process.env.R3_TEST_BLOB_ROOT),
        render: async () => {
          process.stdout.write("preparing\\n");
          await Bun.sleep(60000);
          return { html: "unreachable", revision: "test" };
        },
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        R3_TEST_MIGRATION: new URL("./migration.ts", import.meta.url).href,
        R3_TEST_BLOBS: new URL("./blobs.ts", import.meta.url).href,
        R3_TEST_DB: join(root, "store.sqlite"),
        R3_TEST_BACKUP: join(root, "interrupted.sqlite"),
        R3_TEST_BLOB_ROOT: join(root, "blobs"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const timeout = setTimeout(() => child.kill(), 4000);
    try {
      const output = await reader.read();
      expect(new TextDecoder().decode(output.value)).toContain("preparing");
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
      db = new Database(join(root, "store.sqlite"));
    }
    expect(db.query("SELECT id FROM reviews").all()).toEqual([{ id: "review_retained" }]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect((await migrateLegacyStore(db, options())).migrated).toBe(true);
  });
});
