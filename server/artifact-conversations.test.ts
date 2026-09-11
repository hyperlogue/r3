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
