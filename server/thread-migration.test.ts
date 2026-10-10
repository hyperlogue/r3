import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_SCHEMA_VERSION } from "./artifact-schema.ts";
import { openArtifactStorage } from "./artifact-storage.ts";
import { canonicalJson } from "./artifact-validation.ts";
import { hashBytes } from "./blobs.ts";
import { upgradeArtifactStore } from "./migration.ts";
import { renameThreads } from "./thread-migration.ts";

test("thread rename preserves identities, evidence, delivery, claims, retries, and activity", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await readFile(new URL("./fixtures/schema-v14.sql", import.meta.url), "utf8"));
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO agent_sessions(id,created_at) VALUES ('agent_kept','2026-10-01');
      INSERT INTO artifacts(id,kind,created_by,discussion_revision,created_at,updated_at)
        VALUES ('artifact_kept','files','human',7,'2026-10-01','2026-10-01');
      INSERT INTO discussions(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at,sent_at,ever_delivered)
        VALUES ('discussion_kept','artifact_kept','files','human','Discussion is captured evidence','artifact','2026-10-01','2026-10-01','2026-10-01',1);
      INSERT INTO comments(id,discussion_id,artifact_id,artifact_kind,author,body,created_at)
        VALUES ('comment_kept','discussion_kept','artifact_kept','files','human','Pending comment','2026-10-01');`);
    db.exec(`INSERT INTO discussion_claims VALUES ('discussion_kept','agent_kept','2026-10-01','2026-10-01','2026-10-02');
      INSERT INTO message_operations VALUES ('artifact_kept','retry-kept','unchanged-hash','discussion_kept',NULL);
      INSERT INTO artifact_activity VALUES ('2026-09-01','threadsAdded',5);`);
    const thread = db.query("SELECT * FROM discussions").all();
    const comments = db.query("SELECT id,body,sent_at FROM comments").all();
    const activity = db.query("SELECT * FROM artifact_activity ORDER BY occurred_at,metric").all();
    db.transaction(() => renameThreads(db)).immediate();
    expect(db.query("SELECT * FROM threads").all()).toEqual(thread);
    expect(db.query("SELECT id,body,sent_at FROM comments").all()).toEqual(comments);
    expect(db.query("SELECT thread_id FROM comments").get()).toEqual({
      thread_id: "discussion_kept",
    });
    expect(db.query("SELECT thread_id,agent_session_id FROM thread_claims").get()).toEqual({
      thread_id: "discussion_kept",
      agent_session_id: "agent_kept",
    });
    expect(db.query("SELECT thread_id,request_hash FROM message_operations").get()).toEqual({
      thread_id: "discussion_kept",
      request_hash: "unchanged-hash",
    });
    expect(db.query("SELECT discussion_revision FROM artifacts").get()).toEqual({
      discussion_revision: 7,
    });
    expect(db.query("SELECT * FROM artifact_activity ORDER BY occurred_at,metric").all()).toEqual(
      activity,
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db.exec("UPDATE threads SET target_kind='legacy' WHERE id='discussion_kept'"),
    ).toThrow("record a placement instead of changing the original target");
    renameThreads(db);
    expect(db.query("SELECT * FROM threads").all()).toEqual(thread);
    db.exec("DELETE FROM threads WHERE id='discussion_kept'");
    expect(db.query("SELECT * FROM comments").all()).toEqual([]);
    expect(db.query("SELECT * FROM thread_claims").all()).toEqual([]);
    expect(db.query("SELECT * FROM artifact_activity ORDER BY occurred_at,metric").all()).toEqual(
      activity,
    );
  } finally {
    db.close();
  }
});

test("schema 14 startup preserves comment retries, delivery snapshots, and private backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-thread-upgrade-"));
  const databasePath = join(root, "store.sqlite");
  const time = "2026-10-01T00:00:00.000Z";
  const input = {
    actor: { role: "human" as const, sessionId: null },
    body: "Existing discussion evidence",
    target: { kind: "artifact" as const },
    operationKey: "existing-key",
  };
  const db = new Database(databasePath);
  try {
    db.exec(await readFile(new URL("./fixtures/schema-v14.sql", import.meta.url), "utf8"));
    db.exec("PRAGMA foreign_keys=ON; INSERT INTO artifact_activity_coverage VALUES (1,NULL)");
    db.query(`INSERT INTO artifacts(id,kind,created_by,discussion_revision,created_at,updated_at)
      VALUES ('artifact_kept','files','human',7,?,?)`).run(time, time);
    db.query(`INSERT INTO discussions(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at,sent_at,ever_delivered)
      VALUES ('discussion_kept','artifact_kept','files','human',?,'artifact',?,?,?,1)`).run(
      input.body,
      time,
      time,
      time,
    );
    db.query(`INSERT INTO comments(id,discussion_id,artifact_id,artifact_kind,author,body,created_at)
      VALUES ('comment_kept','discussion_kept','artifact_kept','files','human','Pending follow-up',?)`).run(
      time,
    );
    db.query(
      "INSERT INTO message_operations VALUES ('artifact_kept',?,?,'discussion_kept',NULL)",
    ).run(
      input.operationKey,
      hashBytes(canonicalJson({ kind: "feedback", parentId: "artifact_kept", input })),
    );
    db.close();
    const storage = await openArtifactStorage({ databasePath, clock: () => time });
    try {
      const upgraded = new Database(databasePath, { readonly: true });
      try {
        expect(upgraded.query("PRAGMA user_version").get()).toEqual({
          user_version: ARTIFACT_SCHEMA_VERSION,
        });
        expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        upgraded.close();
      }
      const before = storage.conversations.get("discussion_kept");
      expect(
        before.comments.map((comment) => [comment.id, comment.threadId, comment.sentAt]),
      ).toEqual([
        ["comment_discussion_kept", "discussion_kept", time],
        ["comment_kept", "discussion_kept", null],
      ]);
      expect(await storage.conversations.add("artifact_kept", input)).toEqual(before);
      const snapshot = storage.conversations.snapshot("artifact_kept");
      expect(snapshot.threads.map((thread) => thread.id)).toEqual(["discussion_kept"]);
      expect(snapshot.acknowledgment.expectedFingerprint).toBe(
        hashBytes(JSON.stringify(["artifact_kept", 7, null])),
      );
      storage.conversations.acknowledge("artifact_kept", snapshot.acknowledgment);
      expect(storage.conversations.comment("comment_kept").sentAt).toBe(time);
      const backupPath = storage.migration!.backupPath!;
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
        expect(backup.query("SELECT body,sent_at FROM comments").get()).toEqual({
          body: "Pending follow-up",
          sent_at: null,
        });
      } finally {
        backup.close();
      }
    } finally {
      storage.close();
    }
    const reopened = await openArtifactStorage({ databasePath });
    try {
      expect(reopened.migration?.migrated).toBe(false);
      expect(reopened.conversations.comment("comment_kept").sentAt).toBe(time);
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-media conversation schemas upgrade through quoted thread table renames", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-thread-media-upgrade-"));
  const db = new Database(join(root, "store.sqlite"));
  try {
    const schema = await readFile(new URL("./fixtures/schema-v12.sql", import.meta.url), "utf8");
    db.exec(schema.replaceAll(", 'media'", ""));
    db.exec(`PRAGMA user_version=9;
      INSERT INTO artifact_activity_coverage VALUES (1,NULL);
      INSERT INTO artifacts(id,kind,created_by,created_at,updated_at)
        VALUES ('artifact_kept','files','human','2026-10-01','2026-10-01');
      INSERT INTO feedback(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at)
        VALUES ('feedback_kept','artifact_kept','files','human','Old evidence','artifact','2026-10-01','2026-10-01');`);
    await upgradeArtifactStore(db, { backupPath: join(root, "backup.sqlite") });
    for (const table of ["threads", "comments", "thread_placements"]) {
      const row = db
        .query<{ sql: string }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(table);
      expect(row?.sql).toContain("'media'");
    }
    expect(db.query("SELECT id,body FROM threads").get()).toEqual({
      id: "feedback_kept",
      body: "Old evidence",
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
