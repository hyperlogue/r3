import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { ArtifactLifecycle } from "./artifact-lifecycle.ts";
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
    db.query(`INSERT INTO artifact_events(id,artifact_id,event,operation_key,actor,message,created_at)
      VALUES ('event_archive','artifact_kept','archived','archive-key','human','Historical archive note',?),
        ('event_restore','artifact_kept','restored','restore-key','human',NULL,?)`).run(time, time);
    await upgradeArtifactStore(db, { backupPath: join(root, "backup.sqlite") });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name IN ('feedback','replies')").all(),
    ).toEqual([]);
    expect(
      db.query("SELECT count FROM artifact_activity WHERE metric='commentsAdded'").get(),
    ).toEqual({ count: (before as { count: number }).count + 2 });
    expect(db.query("SELECT request_hash FROM message_operations").get()).toEqual({
      request_hash: "unchanged-hash",
    });
    const store = new ArtifactStore(db, new BlobStore(join(root, "blobs")), async () => ({
      html: "",
      revision: "test",
    }));
    const discussions = new ArtifactConversations(db, store);
    const lifecycle = new ArtifactLifecycle(db, store);
    const archived = lifecycle.events("artifact_kept")[0]!;
    expect(archived.comment).toMatchObject({
      id: "comment_event_archive",
      discussionId: null,
      body: "Historical archive note",
      sentAt: null,
    });
    await discussions.updateComment(archived.comment!.id, {
      actor: { role: "human", sessionId: null },
      body: "Edited after restore",
    });
    const replay = lifecycle.transition("artifact_kept", {
      event: "archived",
      operationKey: "archive-key",
      actor: { role: "human", sessionId: null },
      comment: { body: "Historical archive note" },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.event.id).toBe(archived.id);
    expect(replay.event.comment?.body).toBe("Edited after restore");
    expect(store.get("artifact_kept").state).toBe("active");
    expect(() =>
      db.exec("UPDATE artifact_events SET message='Changed history' WHERE id='event_archive'"),
    ).toThrow("immutable");
    const note = discussions.get("feedback_kept");
    expect(note.comments[0]!.body).toBe("Original feedback and replies are evidence");
    expect(note.comments[0]!.sentAt).toBe(time);
    expect(note.comments.slice(1)[0]).toMatchObject({
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
    expect(discussions.get(note.id).comments.slice(1)).toHaveLength(2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
