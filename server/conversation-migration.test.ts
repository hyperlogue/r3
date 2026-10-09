import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";
import { upgradeArtifactStore } from "./migration.ts";

test("schema 12 upgrades conversation names without rewriting evidence or delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-conversation-upgrade-"));
  const db = new Database(join(root, "store.sqlite"));
  try {
    db.exec(await readFile(new URL("./fixtures/schema-v12.sql", import.meta.url), "utf8"));
    db.exec("INSERT INTO artifact_activity_coverage VALUES (1,NULL)");
    const time = "2026-10-01T00:00:00.000Z";
    db.query(`INSERT INTO artifacts(id,kind,created_by,created_at,updated_at)
      VALUES ('artifact_kept','files','human',?,?)`).run(time, time);
    db.query(`INSERT INTO feedback(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at,sent_at,ever_delivered)
      VALUES ('feedback_kept','artifact_kept','files','human','Original feedback and replies are evidence','artifact',?,?,?,1)`).run(
      time,
      time,
      time,
    );
    db.query(`INSERT INTO replies(id,feedback_id,artifact_id,artifact_kind,author,body,created_at)
      VALUES ('reply_kept','feedback_kept','artifact_kept','files','human','Unsent follow-up',?)`).run(
      time,
    );
    db.exec(
      `INSERT INTO message_operations VALUES ('artifact_kept','retry-key','unchanged-hash','feedback_kept',NULL)`,
    );
    const before = db
      .query("SELECT count FROM artifact_activity WHERE metric='repliesAdded'")
      .get();
    await upgradeArtifactStore(db, { backupPath: join(root, "backup.sqlite") });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name IN ('feedback','replies')").all(),
    ).toEqual([]);
    expect(
      db.query("SELECT count FROM artifact_activity WHERE metric='commentsAdded'").get(),
    ).toEqual(before);
    expect(db.query("SELECT request_hash FROM message_operations").get()).toEqual({
      request_hash: "unchanged-hash",
    });
    const store = new ArtifactStore(db, new BlobStore(join(root, "blobs")), async () => ({
      html: "",
      revision: "test",
    }));
    const discussions = new ArtifactConversations(db, store);
    const note = discussions.get("feedback_kept");
    expect(note.body).toBe("Original feedback and replies are evidence");
    expect(note.sentAt).toBe(time);
    expect(note.comments[0]).toMatchObject({
      id: "reply_kept",
      discussionId: "feedback_kept",
      sentAt: null,
      body: "Unsent follow-up",
    });
    expect(discussions.snapshot("artifact_kept").discussions).toHaveLength(1);
    await discussions.addComment(note.id, {
      actor: { role: "human", sessionId: null },
      body: "After upgrade",
    });
    expect(discussions.get(note.id).comments).toHaveLength(2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
