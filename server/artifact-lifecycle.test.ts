import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ArtifactLifecycle } from "./artifact-lifecycle.ts";
import { createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";

let db: Database;
let artifacts: ArtifactStore;
let lifecycle: ArtifactLifecycle;
let id: string;
let time: string;
const actor = { role: "human", sessionId: null } as const;
beforeEach(() => {
  db = new Database(":memory:");
  createArtifactTables(db);
  time = "2026-09-01T00:00:00.000Z";
  // Lifecycle never writes bytes. A relative unused path makes any accidental
  // storage use visible rather than silently opening the live content store.
  artifacts = new ArtifactStore(
    db,
    new BlobStore("unused-test-blobs"),
    async () => {
      throw new Error("Unexpected rendering");
    },
    () => time,
  );
  lifecycle = new ArtifactLifecycle(db, artifacts, () => time);
  id = artifacts.create({ kind: "files", actor }).id;
});
afterEach(() => db.close());
describe("artifact lifecycle transactions", () => {
  test("archive records a trimmed optional message and restore preserves ordered history", () => {
    const archived = lifecycle.transition(id, {
      actor,
      event: "archived",
      operationKey: "archive-1",
      comment: {
        body: "  Continue tomorrow \n",
      },
    });
    expect(archived.replayed).toBe(false);
    expect(archived.event.comment?.body).toBe("Continue tomorrow");
    expect(artifacts.get(id).state).toBe("archived");
    time = "2026-09-01T01:00:00.000Z";
    const restored = lifecycle.transition(id, {
      actor,
      event: "restored",
      operationKey: "restore-1",
    });
    expect(artifacts.get(id).archivedAt).toBeNull();
    const second = lifecycle.transition(id, {
      actor,
      event: "archived",
      operationKey: "archive-2",
      comment: {
        body: " \n\t ",
      },
    });
    expect(second.event.comment).toBeNull();
    expect(lifecycle.events(id).map((event) => event.seq)).toEqual([
      archived.event.seq,
      restored.event.seq,
      second.event.seq,
    ]);
    expect(lifecycle.events(id)[0].comment?.body).toBe("Continue tomorrow");
  });
  test("retries return their original event without replaying or changing a later state", () => {
    const request = {
      actor,
      event: "archived",
      operationKey: "archive-1",
      comment: {
        body: "Saved",
      },
    };
    const first = lifecycle.transition(id, request);
    expect(lifecycle.transition(id, request)).toEqual({ event: first.event, replayed: true });
    lifecycle.transition(id, { actor, event: "restored", operationKey: "restore-1" });
    expect(lifecycle.transition(id, request).replayed).toBe(true);
    expect(artifacts.get(id).state).toBe("active");
    expect(lifecycle.events(id)).toHaveLength(2);
    expect(() => lifecycle.transition(id, { ...request, comment: { body: "Different" } })).toThrow(
      "already used",
    );
    expect(() =>
      lifecycle.transition(id, { actor, event: "restored", operationKey: "restore-2" }),
    ).toThrow("already active");
  });
  test("claims clear in the transition while content, discussions and unsent state survive", () => {
    artifacts.registerSession({ id: "test-agent" });
    db.query(`INSERT INTO discussions(id, artifact_id, artifact_kind, author, body, target_kind, created_at, updated_at)
      VALUES ('discussion_test', ?, 'files', 'human', 'Pending', 'artifact', ?, ?)`).run(
      id,
      time,
      time,
    );
    db.query(`INSERT INTO discussion_claims(discussion_id, agent_session_id, claimed_at, renewed_at, expires_at)
      VALUES ('discussion_test', 'test-agent', ?, ?, '2026-09-01T01:00:00.000Z')`).run(time, time);
    expect(artifacts.get(id).working).toBe(true);
    lifecycle.transition(id, { actor, event: "archived", operationKey: "archive-1" });
    expect(artifacts.get(id).working).toBe(false);
    expect(
      db.query("SELECT body, status, sent_at FROM discussions WHERE id = 'discussion_test'").get(),
    ).toEqual({ body: "Pending", status: "open", sent_at: null });
    expect(artifacts.get(id).nextSeq).toBe(1);
  });
  test("failed event persistence rolls back the state transition", () => {
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON artifact_events BEGIN SELECT RAISE(ABORT, 'simulated event failure'); END",
    );
    expect(() =>
      lifecycle.transition(id, {
        actor,
        event: "archived",
        operationKey: "archive-1",
        comment: { body: "Atomic archive comment" },
      }),
    ).toThrow("simulated event failure");
    expect(artifacts.get(id).state).toBe("active");
    expect(artifacts.get(id).archivedAt).toBeNull();
    expect(lifecycle.events(id)).toEqual([]);
    expect(db.query("SELECT * FROM artifact_comments").all()).toEqual([]);
  });
});
