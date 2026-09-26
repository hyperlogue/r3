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
  test("unhandled counts follow replies and human resolution, independent of delivery and claims", async () => {
    const note = await conversations.add(id, {
      actor: human,
      body: "Check this",
      target: original,
    });
    expect(artifacts.get(id).unhandledCount).toBe(0);
    await conversations.addReply(note.id, { actor: agent, body: "Please review", context });
    expect(artifacts.list()[0].unhandledCount).toBe(1);
    conversations.claim([note.id], agent.sessionId);
    conversations.deliver(id);
    expect(artifacts.get(id).unhandledCount).toBe(1);
    // All messages share a clock value: insertion order breaks the tie.
    await conversations.addReply(note.id, { actor: human, body: "One more change", context });
    expect(artifacts.get(id).unhandledCount).toBe(0);
    await conversations.addReply(note.id, { actor: agent, body: "Updated", context });
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

    // An existing database can retain description feedback and fix targets.
    db.query(`INSERT INTO feedback(id, artifact_id, artifact_kind, author, body,
      target_kind, target_version_seq, locator_json, created_at, updated_at)
      VALUES ('description-note', ?, 'files', 'human', 'Existing description note',
      'version_summary', 1, ?, ?, ?)`).run(id, JSON.stringify(target.locator), time, time);
    db.query(`INSERT INTO replies(id, feedback_id, artifact_id, artifact_kind, author, body,
      context_version_seq, target_kind, target_version_seq, created_at)
      VALUES ('description-reply', 'description-note', ?, 'files', 'human', 'Existing fix',
      1, 'version_summary', 2, ?)`).run(id, time);
    expect(conversations.get("description-note").target).toEqual(target);
    expect(conversations.reply("description-reply").target).toEqual({
      kind: "version_summary",
      versionSeq: 2,
      locator: null,
    });

    await expect(
      conversations.addReply("description-note", {
        actor: agent,
        body: "New fix",
        context,
        target,
      }),
    ).rejects.toThrow("read-only historical evidence");
    await expect(
      conversations.place("description-note", { actor: agent, state: "anchored", target }),
    ).rejects.toThrow("read-only historical evidence");
    expect(conversations.get("description-note").replies).toHaveLength(1);
    await conversations.addReply("description-note", {
      actor: agent,
      body: "Still discussing this",
      context,
    });
    const resolved = conversations.edit("description-note", { actor: human, status: "resolved" });
    expect(resolved.target).toEqual(target);
    expect(resolved.replies).toHaveLength(2);
    expect(resolved.status).toBe("resolved");
  });

  test("original feedback, message context and fix target retain their separate versions and representations", async () => {
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
    const reply = await conversations.addReply(note.id, {
      actor: agent,
      body: "Updated the heading",
      context,
      target: fix,
    });
    expect(reply.context).toEqual(context);
    expect(reply.target).toEqual(fix);
    expect(reply.author).toEqual(agent);
    const thread = conversations.get(note.id);
    expect(thread.target).toEqual(original);
    expect(thread.status).toBe("open");
    expect(thread.replies.map((reply) => reply.id)).toEqual([reply.id]);
    await expect(
      conversations.addReply(note.id, { actor: agent, body: "Missing context" }),
    ).rejects.toThrow("context");
    expect(conversations.get(note.id).replies).toHaveLength(1);
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
    const reply = await conversations.addReply(note.id, { actor: agent, body: "Thanks", context });
    expect(() => conversations.editReply(reply.id, { actor: other, body: "Different" })).toThrow(
      "their own",
    );
    expect(() =>
      conversations.editReply(reply.id, {
        actor: human,
        body: "Different",
        context: { versionSeq: 2, representation: "source" },
      }),
    ).toThrow("immutable");
    expect(conversations.editReply(reply.id, { actor: agent, body: "Thank you" }).context).toEqual(
      context,
    );
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

  test("an in-flight reply on an archived artifact persists without reopening or resolving it", async () => {
    const note = await conversations.add(id, { actor: human, body: "Work", target: original });
    db.query("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?").run(time, id);
    await conversations.addReply(note.id, {
      actor: agent,
      body: "Reporting the work already completed",
      context,
    });
    expect(artifacts.get(id).state).toBe("archived");
    expect(conversations.get(note.id).status).toBe("open");
    expect(conversations.get(note.id).replies).toHaveLength(1);
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

  test("only a successful reply from the claim owner releases it", async () => {
    const feedback = await note();
    conversations.claim([feedback.id], agent.sessionId);
    await expect(
      conversations.addReply(feedback.id, { actor: agent, body: "", context }),
    ).rejects.toThrow();
    await conversations.addReply(feedback.id, { actor: human, body: "More detail", context });
    await conversations.addReply(feedback.id, { actor: other, body: "An observation", context });
    expect(conversations.get(feedback.id).claim?.sessionId).toBe(agent.sessionId);
    await conversations.addReply(feedback.id, { actor: agent, body: "Handled", context });
    expect(conversations.get(feedback.id).claim).toBeNull();
    expect(conversations.get(feedback.id).status).toBe("open");
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
    const feedback = await note();
    conversations.claim([feedback.id], agent.sessionId);
    conversations.edit(feedback.id, { actor: human, status: "resolved" });
    expect(conversations.get(feedback.id).claim).toBeNull();
    expect(() => conversations.claim([feedback.id], agent.sessionId)).toThrow("Resolved");
    conversations.edit(feedback.id, { actor: human, status: "open" });
    db.query("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?").run(time, id);
    expect(() => conversations.claim([feedback.id], agent.sessionId)).toThrow("archived");
  });
});

describe("owner handoff delivery", () => {
  test("reads preserve pending work and a selected handoff stamps only its captured threads", async () => {
    const a = await conversations.add(id, { actor: human, body: "First", target: original });
    const b = await conversations.add(id, { actor: human, body: "Second", target: original });
    const guidance = await conversations.add(id, {
      actor: agent,
      body: "Reading guidance",
      target: original,
    });
    await conversations.addReply(a.id, { actor: human, body: "Details", context });
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([a.id, b.id]);
    expect(conversations.get(a.id).sentAt).toBeNull();
    const delivered = conversations.deliver(id, [a.id]);
    expect(delivered.map((item) => item.id)).toEqual([a.id]);
    expect(delivered[0].sentAt).toBeNull(); // snapshot before its delivery stamp
    expect(conversations.get(a.id).sentAt).toBe(time);
    expect(conversations.get(a.id).replies[0].sentAt).toBe(time);
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([b.id]);
    expect(conversations.get(guidance.id).sentAt).toBe(time);
    conversations.deliver(id);
    expect(conversations.deliver(id)).toEqual([]);
  });

  test("edited human content re-enters delivery while no-op and agent edits retain their stamps", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    const reply = await conversations.addReply(note.id, {
      actor: human,
      body: "Initial reply",
      context,
    });
    const agentReply = await conversations.addReply(note.id, {
      actor: agent,
      body: "Acknowledged",
      context,
    });
    conversations.deliver(id);
    time = "2026-09-01T00:10:00.000Z";
    conversations.edit(note.id, { actor: human, body: "Original" });
    conversations.editReply(reply.id, { actor: human, body: "Initial reply" });
    conversations.editReply(agentReply.id, { actor: agent, body: "Acknowledged with a detail" });
    expect(conversations.unsent(id)).toEqual([]);
    conversations.edit(note.id, { actor: human, body: "Corrected" });
    conversations.editReply(reply.id, { actor: human, body: "Corrected reply" });
    const pending = conversations.unsent(id);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe("Corrected");
    expect(pending[0].replies.find((item) => item.id === reply.id)?.sentAt).toBeNull();
    conversations.deliver(id);
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
    await conversations.addReply(note.id, { actor: human, body: "Answer", context });
    expect(conversations.unsent(id)).toHaveLength(1);
    const handoff = conversations.deliver(id)[0];
    expect(handoff.status).toBe("resolved");
    expect(handoff.statusUnsent).toBe(true);
    expect(handoff.replies[0].body).toBe("Answer");
    expect(conversations.unsent(id)).toEqual([]);
    conversations.edit(note.id, { actor: human, status: "open" });
    expect(conversations.unsent(id)).toHaveLength(1);
  });

  test("resolving an edited delivered note still hands off its status", async () => {
    const note = await conversations.add(id, { actor: human, body: "Original", target: original });
    conversations.deliver(id);
    conversations.edit(note.id, { actor: human, body: "Changed after delivery" });
    expect(conversations.get(note.id).sentAt).toBeNull();
    conversations.edit(note.id, { actor: human, status: "resolved" });
    expect(conversations.unsent(id).map((item) => item.id)).toEqual([note.id]);
    const [snapshot] = conversations.deliver(id);
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
    expect(() => conversations.deliver(id)).toThrow("archived");
    expect(conversations.get(note.id).sentAt).toBeNull();
    expect(conversations.unsent(id)).toHaveLength(1);
    db.query("UPDATE artifacts SET state = 'active', archived_at = NULL WHERE id = ?").run(id);
    expect(conversations.deliver(id)).toHaveLength(1);
    expect(conversations.unsent(id)).toEqual([]);
  });
});
