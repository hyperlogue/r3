import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";

let root: string;
let db: Database;
let artifacts: ArtifactStore;
let conversations: ArtifactConversations;
let id: string;
let time: string;
const human = { role: "human", sessionId: null } as const;
const agent = { role: "agent", sessionId: "test-agent" } as const;
const other = { role: "agent", sessionId: "other-agent" } as const;
const context = { versionSeq: 1, representation: "rendered" } as const;
const original = {
  kind: "source",
  versionSeq: 1,
  path: "index.md",
  locator: { start: 1, end: 1, quote: "# Old" },
} as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-conversations-"));
  db = new Database(":memory:");
  createArtifactTables(db);
  time = "2026-09-01T00:00:00.000Z";
  artifacts = new ArtifactStore(
    db,
    new BlobStore(root),
    async (text) => ({ html: text, revision: "test" }),
    () => time,
  );
  conversations = new ArtifactConversations(db, artifacts, () => time);
  artifacts.registerSession({ id: agent.sessionId });
  artifacts.registerSession({ id: other.sessionId });
  id = artifacts.create({ kind: "files", actor: agent }).id;
  for (const [seq, text] of [
    [1, "# Old"],
    [2, "# New"],
  ] as const) {
    await artifacts.publish(id, {
      actor: agent,
      expectedSeq: seq - 1,
      publicationKey: `version-${seq}`,
      content: {
        kind: "files",
        files: [
          {
            path: "index.md",
            mediaType: "text/markdown",
            base64: Buffer.from(text).toString("base64"),
          },
        ],
      },
    });
  }
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("artifact conversations", () => {
  test("unhandled counts follow comments and human resolution, independent of delivery and claims", async () => {
    const note = await conversations.add(id, {
      actor: human,
      body: "Check this",
      target: original,
    });
    expect(artifacts.get(id).unhandledCount).toBe(0);
    await conversations.addComment(note.id, { actor: agent, body: "Please review", context });
    expect(artifacts.list()[0].unhandledCount).toBe(1);
    conversations.claim([note.id], agent.sessionId);
    conversations.acknowledge(id, conversations.snapshot(id).acknowledgment);
    expect(artifacts.get(id).unhandledCount).toBe(1);
    // All messages share a clock value: insertion order breaks the tie.
    await conversations.addComment(note.id, { actor: human, body: "One more change", context });
    expect(artifacts.get(id).unhandledCount).toBe(0);
    await conversations.addComment(note.id, { actor: agent, body: "Updated", context });
    expect(artifacts.get(id).unhandledCount).toBe(1);
    conversations.edit(note.id, { actor: human, status: "resolved" });
    expect(artifacts.get(id).unhandledCount).toBe(0);
    conversations.edit(note.id, { actor: human, status: "open" });
    expect(artifacts.get(id).unhandledCount).toBe(1);
    await conversations.add(id, { actor: agent, body: "Another question", target: original });
    expect(artifacts.get(id).unhandledCount).toBe(2);
  });

  test("retired description targets reject new writes while old threads remain usable", async () => {
    const target = {
      kind: "version_summary",
      versionSeq: 1,
      locator: { quote: "Original description" },
    } as const;
    await expect(
      conversations.add(id, { actor: human, body: "New description note", target }),
    ).rejects.toThrow("read-only historical evidence");
    expect(conversations.list(id)).toHaveLength(0);

    // An existing database can retain description discussions and fix targets.
    db.query(`INSERT INTO discussions(id, artifact_id, artifact_kind, author, body,
      target_kind, target_version_seq, locator_json, created_at, updated_at)
      VALUES ('description-note', ?, 'files', 'human', 'Existing description note',
      'version_summary', 1, ?, ?, ?)`).run(id, JSON.stringify(target.locator), time, time);
    db.query(`INSERT INTO comments(id, discussion_id, artifact_id, artifact_kind, author, body,
      context_version_seq, target_kind, target_version_seq, created_at)
      VALUES ('description-comment', 'description-note', ?, 'files', 'human', 'Existing fix',
      1, 'version_summary', 2, ?)`).run(id, time);
    expect(conversations.get("description-note").target).toEqual(target);
    expect(conversations.comment("description-comment").context).toEqual({
      versionSeq: 1,
      representation: null,
    });
    expect(conversations.comment("description-comment").target).toEqual({
      kind: "version_summary",
      versionSeq: 2,
      locator: null,
    });

    await expect(
      conversations.addComment("description-note", {
        actor: agent,
        body: "New fix",
        context,
        target,
      }),
    ).rejects.toThrow("read-only historical evidence");
    await expect(
      conversations.place("description-note", { actor: agent, state: "anchored", target }),
    ).rejects.toThrow("read-only historical evidence");
    expect(conversations.get("description-note").comments).toHaveLength(1);
    await conversations.addComment("description-note", {
      actor: agent,
      body: "Still discussing this",
      context,
    });
    const resolved = conversations.edit("description-note", { actor: human, status: "resolved" });
    expect(resolved.target).toEqual(target);
    expect(resolved.comments).toHaveLength(2);
    expect(resolved.status).toBe("resolved");
  });

  test("comment references derive from their own target or the original discussion target", async () => {
    const note = await conversations.add(id, {
      actor: human,
      body: "Please revise this",
      target: original,
    });
    const fix = {
      kind: "source",
      versionSeq: 2,
      path: "index.md",
      locator: { start: 1, end: 1, quote: "# New" },
    } as const;
    const comment = await conversations.addComment(note.id, {
      actor: agent,
      body: "Updated the heading",
      context,
      target: fix,
    });
    expect(comment.context).toEqual({ versionSeq: 2, representation: "source" });
    expect(comment.target).toEqual(fix);
    expect(comment.author).toEqual(agent);
    const thread = conversations.get(note.id);
    expect(thread.target).toEqual(original);
    expect(thread.status).toBe("open");
    expect(thread.comments.map((comment) => comment.id)).toEqual([comment.id]);
    const inherited = await conversations.addComment(note.id, {
      actor: agent,
      body: "Inherited reference",
    });
    expect(inherited.context).toEqual({ versionSeq: 1, representation: "source" });
    const general = await conversations.add(id, {
      actor: human,
      body: "General discussion",
      target: { kind: "artifact" },
    });
    expect(
      (await conversations.addComment(general.id, { actor: agent, body: "No version" })).context,
    ).toEqual({ versionSeq: null, representation: null });
    expect(conversations.get(note.id).comments).toHaveLength(2);
  });

  test("human status changes and authored message edits preserve original targets and attribution", async () => {
    const note = await conversations.add(id, {
      actor: agent,
      body: "A question",
      target: original,
    });
    expect(note.sentAt).toBe(time);
    expect(() => conversations.edit(note.id, { actor: agent, status: "resolved" })).toThrow(
      "human owner",
    );
    expect(() => conversations.edit(note.id, { actor: other, body: "Rewrite" })).toThrow(
      "their own",
    );
    expect(() =>
      conversations.edit(note.id, { actor: human, target: { kind: "artifact" } }),
    ).toThrow("immutable");
    time = "2026-09-01T01:00:00.000Z";
    expect(conversations.edit(note.id, { actor: agent, body: "A question" }).updatedAt).toBe(
      note.updatedAt,
    );
    const resolved = conversations.edit(note.id, { actor: human, status: "resolved" });
    expect(resolved.status).toBe("resolved");
    expect(resolved.statusUnsent).toBe(true);
    expect(resolved.author).toEqual(agent);
    expect(resolved.target).toEqual(original);
    const comment = await conversations.addComment(note.id, {
      actor: agent,
      body: "Thanks",
      context,
    });
    expect(() =>
      conversations.editComment(comment.id, { actor: other, body: "Different" }),
    ).toThrow("their own");
    expect(() =>
      conversations.editComment(comment.id, {
        actor: human,
        body: "Different",
        context: { versionSeq: 2, representation: "source" },
      }),
    ).toThrow("immutable");
    expect(
      conversations.editComment(comment.id, { actor: agent, body: "Thank you" }).context,
    ).toEqual({
      versionSeq: 1,
      representation: "source",
    });
    expect(conversations.get(note.id).status).toBe("resolved");
  });

  test("additional placements never replace or duplicate the original thread", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    const target = {
      kind: "rendered",
      versionSeq: 2,
      path: "index.md",
      locator: { selector: "h1", quote: "New" },
    } as const;
    const placement = await conversations.place(note.id, {
      actor: agent,
      state: "anchored",
      target,
    });
    expect(placement.target).toEqual(target);
    const unavailable = await conversations.place(note.id, {
      actor: agent,
      state: "unplaced",
      target: { ...target, locator: null },
    });
    expect(unavailable.createdAt).toBe(placement.createdAt);
    expect(unavailable.state).toBe("unplaced");
    expect(conversations.placements(id)).toHaveLength(1);
    expect(conversations.list(id)).toHaveLength(1);
    expect(conversations.get(note.id).target).toEqual(original);
    await expect(
      conversations.place(note.id, { actor: agent, state: "ambiguous", target }),
    ).rejects.toThrow("cannot claim a locator");
  });

  test("archive rejects a comment whose target preparation began before the transition", async () => {
    const note = await conversations.add(id, { actor: human, body: "Work", target: original });
    const pending = conversations.addComment(note.id, {
      actor: agent,
      body: "Reporting the work already completed",
      context,
      target: original,
    });
    db.query("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?").run(time, id);
    await expect(pending).rejects.toThrow("Artifact is archived");
    expect(conversations.get(note.id).comments).toHaveLength(0);
    expect(conversations.get(note.id).status).toBe("open");
  });
});

describe("agent session claims", () => {
  const note = () => conversations.add(id, { actor: human, body: "Work", target: original });

  test("agents claim independent items, renew their own lease, and leave activity and delivery unchanged", async () => {
    const a = await note();
    const b = await note();
    const updated = artifacts.get(id).updatedAt;
    const first = conversations.claim([a.id], agent.sessionId)[0];
    conversations.claim([b.id], other.sessionId);
    expect(artifacts.get(id).working).toBe(true);
    time = "2026-09-01T00:30:00.000Z";
    const renewed = conversations.claim([a.id], agent.sessionId)[0];
    expect(renewed.claimedAt).toBe(first.claimedAt);
    expect(renewed.expiresAt).toBe("2026-09-01T01:30:00.000Z");
    expect(artifacts.get(id).updatedAt).toBe(updated);
    expect(conversations.get(a.id).sentAt).toBeNull();
    expect(() => conversations.claim([a.id], other.sessionId)).toThrow("another agent");
    conversations.release([a.id], other.sessionId);
    expect(conversations.get(a.id).claim?.sessionId).toBe(agent.sessionId);
  });

  test("only a successful comment from the claim owner releases it", async () => {
    const discussions = await note();
    conversations.claim([discussions.id], agent.sessionId);
    await expect(
      conversations.addComment(discussions.id, { actor: agent, body: "", context }),
    ).rejects.toThrow();
    await conversations.addComment(discussions.id, { actor: human, body: "More detail", context });
    await conversations.addComment(discussions.id, {
      actor: other,
      body: "An observation",
      context,
    });
    expect(conversations.get(discussions.id).claim?.sessionId).toBe(agent.sessionId);
    await conversations.addComment(discussions.id, { actor: agent, body: "Handled", context });
    expect(conversations.get(discussions.id).claim).toBeNull();
    expect(conversations.get(discussions.id).status).toBe("open");
  });

  test("batch conflicts roll back all new claims and expiry allows a fresh owner", async () => {
    const a = await note();
    const b = await note();
    conversations.claim([b.id], other.sessionId);
    expect(() => conversations.claim([a.id, b.id], agent.sessionId)).toThrow("another agent");
    expect(conversations.get(a.id).claim).toBeNull();
    time = "2026-09-01T01:00:00.000Z";
    expect(conversations.get(b.id).claim).toBeNull();
    expect(artifacts.get(id).working).toBe(false);
    const fresh = conversations.claim([b.id], agent.sessionId)[0];
    expect(fresh.claimedAt).toBe(time);
    time = "2026-09-01T02:00:00.000Z";
    expect(conversations.expireClaims()).toEqual([id]);
    expect(conversations.expireClaims()).toEqual([]);
  });

  test("resolution clears the lease and resolved or archived work cannot be claimed", async () => {
    const discussions = await note();
    conversations.claim([discussions.id], agent.sessionId);
    conversations.edit(discussions.id, { actor: human, status: "resolved" });
    expect(conversations.get(discussions.id).claim).toBeNull();
    expect(() => conversations.claim([discussions.id], agent.sessionId)).toThrow("Resolved");
    conversations.edit(discussions.id, { actor: human, status: "open" });
    db.query("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?").run(time, id);
    expect(() => conversations.claim([discussions.id], agent.sessionId)).toThrow("archived");
  });
});

describe("owner handoff delivery", () => {
  test("snapshot revisions reject edits, comment reverts, changed selections, and old acknowledgment retries", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    const first = conversations.snapshot(id);
    conversations.edit(note.id, { actor: human, body: "Temporary" });
    conversations.edit(note.id, { actor: human, body: "Original" });
    expect(() => conversations.acknowledge(id, first.acknowledgment)).toThrow("Discussion changed");
    const comment = await conversations.addComment(note.id, {
      actor: human,
      body: "Comment",
      context,
    });
    const beforeCommentEdit = conversations.snapshot(id);
    conversations.editComment(comment.id, { actor: human, body: "Temporary comment" });
    conversations.editComment(comment.id, { actor: human, body: "Comment" });
    expect(() => conversations.acknowledge(id, beforeCommentEdit.acknowledgment)).toThrow(
      "Discussion changed",
    );
    const selected = conversations.snapshot(id, [note.id]);
    expect(() =>
      conversations.acknowledge(id, {
        expectedFingerprint: selected.acknowledgment.expectedFingerprint,
      }),
    ).toThrow("Discussion changed");
    conversations.acknowledge(id, selected.acknowledgment);
    conversations.edit(note.id, { actor: human, body: "New pending body" });
    expect(() => conversations.acknowledge(id, selected.acknowledgment)).toThrow(
      "Discussion changed",
    );
    expect(conversations.get(note.id).sentAt).toBeNull();
  });

  test("reads preserve pending work and a selected handoff stamps only its captured threads", async () => {
    const a = await conversations.add(id, { actor: human, body: "First", target: original });
    const b = await conversations.add(id, { actor: human, body: "Second", target: original });
    const guidance = await conversations.add(id, {
      actor: agent,
      body: "Reading guidance",
      target: original,
    });
    await conversations.addComment(a.id, { actor: human, body: "Details", context });
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([a.id, b.id]);
    expect(conversations.get(a.id).sentAt).toBeNull();
    const delivered = conversations.acknowledge(
      id,
      conversations.snapshot(id, [a.id]).acknowledgment,
    );
    expect(delivered.map((item) => item.id)).toEqual([a.id]);
    expect(delivered[0].sentAt).toBeNull(); // snapshot before its delivery stamp
    expect(conversations.get(a.id).sentAt).toBe(time);
    expect(conversations.get(a.id).comments[0].sentAt).toBe(time);
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([b.id]);
    expect(conversations.get(guidance.id).sentAt).toBe(time);
    conversations.acknowledge(id, conversations.snapshot(id).acknowledgment);
    expect(conversations.acknowledge(id, conversations.snapshot(id).acknowledgment)).toEqual([]);
  });

  test("edited human content re-enters delivery while no-op and agent edits retain their stamps", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    const comment = await conversations.addComment(note.id, {
      actor: human,
      body: "Initial comment",
      context,
    });
    const agentComment = await conversations.addComment(note.id, {
      actor: agent,
      body: "Acknowledged",
      context,
    });
    conversations.acknowledge(id, conversations.snapshot(id).acknowledgment);
    time = "2026-09-01T00:10:00.000Z";
    conversations.edit(note.id, { actor: human, body: "Original" });
    conversations.editComment(comment.id, { actor: human, body: "Initial comment" });
    conversations.editComment(agentComment.id, {
      actor: agent,
      body: "Acknowledged with a detail",
    });
    expect(conversations.unsent(id)).toEqual([]);
    conversations.edit(note.id, { actor: human, body: "Corrected" });
    conversations.editComment(comment.id, { actor: human, body: "Corrected comment" });
    const pending = conversations.unsent(id);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe("Corrected");
    expect(pending[0].comments.find((item) => item.id === comment.id)?.sentAt).toBeNull();
    conversations.acknowledge(id, conversations.snapshot(id).acknowledgment);
    expect(conversations.unsent(id)).toEqual([]);
  });

  test("status updates and human follow-ups to agent notes are delivered once, even when resolved", async () => {
    const note = await conversations.add(id, {
      actor: agent,
      body: "Question for the owner",
      target: original,
    });
    expect(conversations.unsent(id)).toEqual([]);
    conversations.edit(note.id, { actor: human, status: "resolved" });
    await conversations.addComment(note.id, { actor: human, body: "Answer", context });
    expect(conversations.unsent(id)).toHaveLength(1);
    const handoff = conversations.acknowledge(id, conversations.snapshot(id).acknowledgment)[0];
    expect(handoff.status).toBe("resolved");
    expect(handoff.statusUnsent).toBe(true);
    expect(handoff.comments[0].body).toBe("Answer");
    expect(conversations.unsent(id)).toEqual([]);
    conversations.edit(note.id, { actor: human, status: "open" });
    expect(conversations.unsent(id)).toHaveLength(1);
  });

  test("resolving an edited delivered note still hands off its status", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    conversations.acknowledge(id, conversations.snapshot(id).acknowledgment);
    conversations.edit(note.id, { actor: human, body: "Changed after delivery" });
    expect(conversations.get(note.id).sentAt).toBeNull();
    conversations.edit(note.id, { actor: human, status: "resolved" });
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([note.id]);
    const [snapshot] = conversations.acknowledge(id, conversations.snapshot(id).acknowledgment);
    expect(snapshot.statusUnsent).toBe(true);
    expect(snapshot.status).toBe("resolved");
    expect(conversations.unsent(id)).toEqual([]);
  });

  test("resolving an edited never-delivered note does not create status work", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    conversations.edit(note.id, { actor: human, body: "Changed before delivery" });
    conversations.edit(note.id, { actor: human, status: "resolved" });
    expect(conversations.get(note.id).statusUnsent).toBe(false);
    expect(conversations.unsent(id)).toEqual([]);
    conversations.edit(note.id, { actor: human, status: "open" });
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([note.id]);
  });

  test("archive blocks ordinary handoff and preserves pending messages for restore", async () => {
    const note = await conversations.add(id, { actor: human, body: "Pending", target: original });
    db.query("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?").run(time, id);
    expect(() => conversations.acknowledge(id, conversations.snapshot(id).acknowledgment)).toThrow(
      "archived",
    );
    expect(conversations.get(note.id).sentAt).toBeNull();
    expect(conversations.unsent(id)).toHaveLength(1);
    db.query("UPDATE artifacts SET state = 'active', archived_at = NULL WHERE id = ?").run(id);
    expect(conversations.acknowledge(id, conversations.snapshot(id).acknowledgment)).toHaveLength(
      1,
    );
    expect(conversations.unsent(id)).toEqual([]);
  });
});
