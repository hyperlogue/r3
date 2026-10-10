import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
