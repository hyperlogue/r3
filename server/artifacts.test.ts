import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactActor, PublishArtifactBody } from "../shared/artifacts.ts";
import { createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";
import type { DocumentRenderer } from "./publication.ts";

const human: ArtifactActor = { role: "human", sessionId: null };
const agent: ArtifactActor = { role: "agent", sessionId: "test-agent" };
let root: string;
let db: Database;
let blobs: BlobStore;
let store: ArtifactStore;
let renderer: DocumentRenderer;
let revision: string;
const clock = () => "2026-09-01T00:00:00.000Z";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-artifacts-"));
  db = new Database(join(root, "test.sqlite"));
  createArtifactTables(db);
  blobs = new BlobStore(join(root, "blobs"));
  revision = "renderer-1";
  renderer = async (source) => ({ html: `<article>${source}</article>`, revision });
  store = new ArtifactStore(db, blobs, (...args) => renderer(...args), clock);
  store.registerSession({ id: agent.sessionId, harness: "test" });
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

function directory(
  key: string,
  expectedSeq: number,
  members: Record<string, string | Buffer>,
): PublishArtifactBody {
  return {
    publicationKey: key,
    expectedSeq,
    actor: agent,
    content: {
      kind: "files",
      files: Object.entries(members).map(([path, bytes]) => ({
        path,
        mediaType: "application/octet-stream",
        base64: Buffer.from(bytes).toString("base64"),
      })),
    },
  };
}

describe("artifact publications", () => {
  test("storage counts distinct published bytes across paths and versions", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    expect(store.get(id).storage).toEqual({ totalBytes: 0, latestVersionBytes: 0 });
    const binary = Buffer.from([0, 255, 128]);
    const first = directory("one", 0, { a: binary, duplicate: binary, b: "old", empty: "" });
    await store.publish(id, first);
    expect(store.get(id).storage).toEqual({ totalBytes: 6, latestVersionBytes: 6 });
    await store.publish(id, directory("two", 1, { renamed: binary, b: "new" }));
    await store.publish(id, first);
    expect(store.get(id).storage).toEqual({ totalBytes: 9, latestVersionBytes: 6 });

    // Allocation gaps must not make the latest publication disappear from accounting.
    db.query("UPDATE artifacts SET next_seq = 8 WHERE id = ?").run(id);
    expect(store.get(id).storage.latestVersionBytes).toBe(6);
    await store.publish(id, directory("three", 2, { renamed: binary }));
    expect(store.get(id).storage).toEqual({ totalBytes: 9, latestVersionBytes: 3 });

    const other = store.create({ kind: "files", actor: human }).id;
    await store.publish(other, directory("shared", 0, { a: binary }));
    expect(store.list().find((item) => item.id === other)?.storage).toEqual({
      totalBytes: 3,
      latestVersionBytes: 3,
    });
    store.delete(other);
    db.close();
    db = new Database(join(root, "test.sqlite"));
    store = new ArtifactStore(db, blobs, renderer, clock);
    expect(store.get(id).storage).toEqual({ totalBytes: 9, latestVersionBytes: 3 });
  });

  test("storage includes retained Markdown without double counting a matching original", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    const source = "# café";
    const retained = `<article>${source}</article>`;
    const request = directory("markdown", 0, { "index.md": source, "same.html": retained });
    await store.publish(id, request);
    const originalBytes = Buffer.byteLength(source);
    const retainedBytes = Buffer.byteLength(retained);
    expect(store.get(id).storage).toEqual({
      totalBytes: originalBytes + retainedBytes,
      latestVersionBytes: originalBytes + retainedBytes,
    });
    renderer = async () => ({ html: "<h1>Revised</h1>", revision: "renderer-2" });
    const next = directory("revised", 1, { "index.md": source });
    await store.publish(id, next);
    expect(store.get(id).storage).toEqual({
      totalBytes: originalBytes + retainedBytes + Buffer.byteLength("<h1>Revised</h1>"),
      latestVersionBytes: originalBytes + Buffer.byteLength("<h1>Revised</h1>"),
    });
  });

  test("storage counts UTF-8 patch bytes per publication, including identical patches", async () => {
    const id = store.create({ kind: "diff", actor: human }).id;
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+café 🐈\n";
    for (let seq = 0; seq < 2; seq++) {
      await store.publish(id, {
        publicationKey: `patch-${seq}`,
        expectedSeq: seq,
        actor: human,
        content: { kind: "diff", patch },
      });
    }
    expect(store.get(id).storage).toEqual({
      totalBytes: Buffer.byteLength(patch) * 2,
      latestVersionBytes: Buffer.byteLength(patch),
    });
  });

  test("failed publications and unreferenced blobs do not count as artifact storage", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    await blobs.put("unreferenced bytes");
    db.exec(`CREATE TRIGGER fail_storage_publication BEFORE UPDATE OF published_at ON artifact_versions
      BEGIN SELECT RAISE(ABORT, 'publication failed'); END`);
    await expect(store.publish(id, directory("failed", 0, { a: "prepared" }))).rejects.toThrow(
      "publication failed",
    );
    expect(store.get(id).storage).toEqual({ totalBytes: 0, latestVersionBytes: 0 });
  });

  test("artifact metadata has no overview while publications retain their summaries", async () => {
    expect(() => store.create({ kind: "files", actor: human, summary: "Removed" })).toThrow(
      "overview was removed",
    );
    const artifact = store.create({ kind: "files", actor: human });
    expect(artifact).not.toHaveProperty("summary");
    expect(() => store.edit(artifact.id, { summary: "Removed" })).toThrow("overview was removed");
    const version = await store.publish(artifact.id, {
      ...directory("summary", 0, { "notes.txt": "Content" }),
      summary: "Publication notes",
    });
    expect(version.summary).toBe("Publication notes");
  });
  test("project grouping is optional and deleting a group preserves artifacts and read progress", () => {
    const project = store.createProject({ name: "Examples" });
    const grouped = store.create({ kind: "files", actor: human, projectId: project.id });
    const ungrouped = store.create({ kind: "files", actor: human });
    store.setViewed(grouped.id, { key: "f:notes.md@retained-content", viewed: true });
    store.setViewed(grouped.id, { key: "f:notes.md@retained-content", viewed: true });
    expect(store.viewed(grouped.id)).toEqual(["f:notes.md@retained-content"]);
    expect(store.list({ projectId: project.id }).map((a) => a.id)).toEqual([grouped.id]);
    expect(store.projects()).toEqual([project]);
    expect(() => store.createProject({ id: project.id })).toThrow("already registered");
    store.deleteProject(project.id);
    expect(store.get(grouped.id).projectId).toBeNull();
    expect(store.get(ungrouped.id).projectId).toBeNull();
    expect(store.viewed(grouped.id)).toHaveLength(1);
    store.setViewed(grouped.id, { key: "f:notes.md@retained-content", viewed: false });
    expect(store.viewed(grouped.id)).toEqual([]);
    expect(store.sessions()).toContainEqual(expect.objectContaining({ id: agent.sessionId }));
  });

  test("artifacts need no repo and require registered agent attribution", () => {
    const artifact = store.create({ kind: "files", actor: agent, meta: { task: "design" } });
    expect(artifact.projectId).toBeNull();
    expect(artifact.createdBy).toEqual(agent);
    expect(store.list({ meta: { task: "design" } }).map((a) => a.id)).toEqual([artifact.id]);
    expect(store.list({ meta: { task: "other" } })).toEqual([]);
    expect(() =>
      store.create({ kind: "files", actor: { role: "agent", sessionId: "unregistered" } }),
    ).toThrow("Register");
    expect(() => store.create({ kind: "files" })).toThrow("actor");
    expect(() => store.create({ kind: "files", actor: human, meta: null })).toThrow("object");
    expect(() => store.registerSession({ id: agent.sessionId, harness: "different" })).toThrow(
      "different metadata",
    );
  });

  test("each version owns complete binary membership and old bytes survive reopening", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    await store.publish(id, directory("one", 0, { "data.bin": binary, "empty.txt": "" }));
    await store.publish(id, directory("two", 1, { "other.txt": "new" }));
    expect(store.versions(id).map((v) => v.seq)).toEqual([1, 2]);
    expect(store.files(id, 2).map((f) => f.path)).toEqual(["other.txt"]);
    await expect(store.readFile(id, 2, "data.bin")).rejects.toThrow("absent");
    db.close();
    db = new Database(join(root, "test.sqlite"));
    store = new ArtifactStore(db, new BlobStore(join(root, "blobs")), renderer, clock);
    expect(await store.readFile(id, 1, "data.bin")).toEqual(binary);
    expect(await store.readFile(id, 1, "empty.txt")).toEqual(Buffer.alloc(0));
  });

  test("retained Markdown and retry results survive renderer upgrades and later versions", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    const request = directory("one", 0, { "index.md": "# First" });
    const first = await store.publish(id, request);
    revision = "renderer-2";
    renderer = async () => ({ html: "<h1>Different renderer</h1>", revision });
    await store.publish(id, directory("two", 1, { "index.md": "# Next" }));
    expect(await store.publish(id, request)).toEqual(first);
    expect(store.file(id, 1, "index.md").rendererRevision).toBe("renderer-1");
    expect(store.file(id, 2, "index.md").rendererRevision).toBe("renderer-2");
    expect((await store.readFile(id, 1, "index.md", true)).toString()).toBe(
      "<article># First</article>",
    );
    expect(store.get(id).nextSeq).toBe(3);
    await expect(store.publish(id, directory("one", 0, { "index.md": "changed" }))).rejects.toThrow(
      "already used",
    );
    await expect(store.publish(id, { ...request, label: "different" })).rejects.toThrow(
      "already used",
    );
  });

  test("competing publishers cannot both append against the same expected version", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    const results = await Promise.allSettled([
      store.publish(id, directory("one", 0, { a: "one" })),
      store.publish(id, directory("two", 0, { a: "two" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect(store.versions(id)).toHaveLength(1);
    expect(store.get(id).nextSeq).toBe(2);
    const next = await store.publish(id, directory("three", 1, { a: "three" }));
    expect(next.seq).toBe(2);
  });

  test("declared renderings are reused across publications and reopening, but not revisions or paths", async () => {
    let calls = 0;
    const render = Object.assign(
      async (source: string, path: string) => {
        calls++;
        return { html: `<article>${path}: ${source}</article>`, revision: "cached-1" };
      },
      { revision: "cached-1" },
    );
    store = new ArtifactStore(db, blobs, render, clock);
    const id = store.create({ kind: "files", actor: human }).id;
    await store.publish(id, directory("one", 0, { "index.md": "# Same" }));
    const hash = store.file(id, 1, "index.md").renderedHash;
    await store.publish(id, directory("two", 1, { "index.md": "# Same", "other.txt": "new" }));
    expect(calls).toBe(1);
    expect(store.file(id, 2, "index.md").renderedHash).toBe(hash);
    db.close();
    db = new Database(join(root, "test.sqlite"));
    store = new ArtifactStore(db, blobs, render, clock);
    await store.publish(id, directory("three", 2, { "index.md": "# Same" }));
    expect(calls).toBe(1);
    await store.publish(id, directory("four", 3, { "renamed.md": "# Same" }));
    expect(calls).toBe(2);
    expect(store.file(id, 4, "renamed.md").renderedHash).not.toBe(hash);
    store = new ArtifactStore(
      db,
      blobs,
      Object.assign(
        async () => ({
          html: "<h1>Upgraded</h1>",
          revision: "cached-2",
        }),
        { revision: "cached-2" },
      ),
      clock,
    );
    await store.publish(id, directory("five", 4, { "index.md": "# Same" }));
    expect(store.file(id, 5, "index.md").renderedHash).not.toBe(hash);
    expect(store.file(id, 1, "index.md").renderedHash).toBe(hash);
  });

  test("publication verifies a cached rendering before reusing its blob", async () => {
    const render = Object.assign(async () => ({ html: "<h1>Kept</h1>", revision: "cached-1" }), {
      revision: "cached-1",
    });
    store = new ArtifactStore(db, blobs, render, clock);
    const id = store.create({ kind: "files", actor: human }).id;
    await store.publish(id, directory("one", 0, { "index.md": "# Same" }));
    const hash = store.file(id, 1, "index.md").renderedHash!;
    await writeFile(join(root, "blobs", hash.slice(0, 2), hash.slice(2)), "corrupt");
    await expect(
      store.publish(id, directory("two", 1, { "index.md": "# Same" })),
    ).rejects.toThrow();
    expect(store.versions(id)).toHaveLength(1);
  });

  test("concurrent retries return one publication", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    const request = directory("one", 0, { a: "same" });
    const results = await Promise.all([store.publish(id, request), store.publish(id, request)]);
    expect(results[0]).toEqual(results[1]);
    expect(store.versions(id)).toHaveLength(1);
  });

  test("rendering failure or a failed finalization leaves no partial version or consumed sequence", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    renderer = async () => {
      throw new Error("render failed");
    };
    await expect(
      store.publish(id, directory("one", 0, { a: "already prepared", "z.md": "render me" })),
    ).rejects.toThrow("render failed");
    expect(store.versions(id)).toEqual([]);
    expect(store.get(id).nextSeq).toBe(1);
    db.exec(`CREATE TRIGGER fail_publication BEFORE UPDATE OF published_at ON artifact_versions
      BEGIN SELECT RAISE(ABORT, 'simulated finalization failure'); END`);
    await expect(store.publish(id, directory("one", 0, { a: "bytes" }))).rejects.toThrow(
      "simulated finalization",
    );
    expect(store.versions(id)).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM version_files").get()!.n).toBe(0);
    expect(store.get(id).nextSeq).toBe(1);
    db.exec("DROP TRIGGER fail_publication");
    expect((await store.publish(id, directory("one", 0, { a: "bytes" }))).seq).toBe(1);
  });

  test("archive during preparation prevents publication while completed retries stay readable", async () => {
    const id = store.create({ kind: "files", actor: human }).id;
    const first = directory("one", 0, { a: "one" });
    await store.publish(id, first);
    renderer = async () => {
      db.query("UPDATE artifacts SET state = 'archived', archived_at = ? WHERE id = ?").run(
        clock(),
        id,
      );
      return { html: "<p>prepared</p>", revision };
    };
    await expect(store.publish(id, directory("two", 1, { "index.md": "two" }))).rejects.toThrow(
      "archived",
    );
    expect(store.versions(id)).toHaveLength(1);
    expect((await store.publish(id, first)).seq).toBe(1);
  });

  test("HTML entrypoint cycles and sparse diff histories are retained until whole deletion", async () => {
    const html = store.create({ kind: "html", actor: human });
    const version = await store.publish(html.id, {
      publicationKey: "one",
      expectedSeq: 0,
      actor: human,
      content: {
        kind: "html",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64: Buffer.from("<h1>Hello</h1>").toString("base64"),
          },
        ],
      },
    });
    expect(version.entrypoint).toBe("index.html");
    expect(() =>
      db.query("DELETE FROM artifact_versions WHERE artifact_id = ?").run(html.id),
    ).toThrow("retained");
    store.delete(html.id);
    expect(() => store.version(html.id, 1)).toThrow("not found");
    const diff = store.create({ kind: "diff", actor: human });
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -7,1 +9,1 @@\n-old\n+new\n";
    await store.publish(diff.id, {
      publicationKey: "one",
      expectedSeq: 0,
      actor: human,
      content: { kind: "diff", patch },
    });
    expect(store.patch(diff.id, 1)).toBe(patch);
    expect(() => store.files(diff.id, 1)).toThrow("not files");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
