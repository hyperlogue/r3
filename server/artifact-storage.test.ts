import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedLegacyMarkdownArtifact } from "../scripts/legacy-markdown-fixture.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { openArtifactStorage } from "./artifact-storage.ts";
import { BlobStore } from "./blobs.ts";

let root: string;
let storage: ArtifactStorage | null;
const time = "2026-09-01T00:00:00.000Z";
const render = async (source: string) => ({
  html: `<article>${source}</article>`,
  revision: "storage-test",
});
const actor = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-artifact-storage-"));
  storage = null;
});
afterEach(async () => {
  storage?.close();
  await rm(root, { recursive: true, force: true });
});
const options = () => ({ databasePath: join(root, "store.sqlite"), render, clock: () => time });
const publication = () => ({
  actor,
  expectedSeq: 0,
  publicationKey: "initial",
  content: {
    kind: "files",
    files: [
      {
        path: "index.md",
        mediaType: "text/markdown",
        base64: Buffer.from("# Shared").toString("base64"),
      },
    ],
  },
});

describe("private artifact storage bootstrap", () => {
  test("a snapshot remains valid across restart but not an edit and revert after restart", async () => {
    storage = await openArtifactStorage(options());
    const id = storage.artifacts.create({ actor, kind: "files" }).id;
    const note = await storage.conversations.add(id, {
      actor,
      body: "Original",
      target: { kind: "artifact" },
    });
    const receipt = storage.conversations.snapshot(id).acknowledgment;
    storage.close();
    storage = await openArtifactStorage(options());
    expect(storage.conversations.snapshot(id).acknowledgment).toEqual(receipt);
    storage.conversations.edit(note.id, { actor, body: "Temporary" });
    storage.conversations.edit(note.id, { actor, body: "Original" });
    storage.close();
    storage = await openArtifactStorage(options());
    expect(() => storage!.conversations.acknowledge(id, receipt)).toThrow("Feedback changed");
    expect(storage.conversations.get(note.id).sentAt).toBeNull();
  });

  test("delivery history survives editing and reopening without promoting new feedback", async () => {
    storage = await openArtifactStorage(options());
    const id = storage.artifacts.create({ actor, kind: "files" }).id;
    const delivered = await storage.conversations.add(id, {
      actor,
      body: "Delivered",
      target: { kind: "artifact" },
    });
    storage.conversations.acknowledge(id, storage.conversations.snapshot(id).acknowledgment);
    storage.conversations.edit(delivered.id, { actor, body: "Edited after delivery" });
    const fresh = await storage.conversations.add(id, {
      actor,
      body: "Never delivered",
      target: { kind: "artifact" },
    });
    storage.close();
    storage = await openArtifactStorage(options());
    storage.conversations.edit(delivered.id, { actor, status: "resolved" });
    storage.conversations.edit(fresh.id, { actor, status: "resolved" });
    expect(storage.conversations.get(delivered.id).sentAt).toBeNull();
    expect(storage.conversations.get(delivered.id).statusUnsent).toBe(true);
    expect(storage.conversations.get(fresh.id).statusUnsent).toBe(false);
    expect(storage.conversations.unsent(id).map((note) => note.id)).toEqual([delivered.id]);
    storage.conversations.acknowledge(id, storage.conversations.snapshot(id).acknowledgment);
    expect(storage.conversations.unsent(id)).toEqual([]);
  });

  test("historical Markdown HTML versions remain readable while new versions require HTML", async () => {
    const previous = publication();
    const id = await seedLegacyMarkdownArtifact(
      options().databasePath,
      [previous.content.files],
      render,
    );
    storage = await openArtifactStorage(options());
    const original = storage.artifacts.file(id, 1, "index.md");
    expect(storage.artifacts.version(id, 1).entrypoint).toBe("index.md");
    expect((await storage.artifacts.readFile(id, 1, "index.md", true)).toString()).toBe(
      "<article># Shared</article>",
    );
    await expect(
      storage.artifacts.publish(id, {
        ...previous,
        expectedSeq: 1,
        content: { ...previous.content, kind: "html" },
      }),
    ).rejects.toThrow("root index.html");
    expect(storage.artifacts.versions(id)).toHaveLength(1);
    await storage.artifacts.publish(id, {
      ...previous,
      expectedSeq: 1,
      content: {
        kind: "html",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64: Buffer.from("<h1>HTML revision</h1>").toString("base64"),
          },
        ],
      },
    });
    storage.close();
    storage = await openArtifactStorage(options());
    expect(storage.artifacts.version(id, 2).entrypoint).toBe("index.html");
    expect(storage.artifacts.version(id, 1).entrypoint).toBe("index.md");
    expect(storage.artifacts.file(id, 1, "index.md")).toEqual(original);
    expect((await storage.artifacts.readFile(id, 1, "index.md", true)).toString()).toBe(
      "<article># Shared</article>",
    );
  });

  test("creates a private store and reopens published content without legacy source access", async () => {
    storage = await openArtifactStorage(options());
    expect(storage.migration).toBeNull();
    const id = storage.artifacts.create({ actor, kind: "files" }).id;
    await storage.artifacts.publish(id, publication());
    expect((await stat(options().databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${options().databasePath}.artifacts`)).mode & 0o777).toBe(0o700);
    storage.close();
    storage = null;
    storage = await openArtifactStorage({
      ...options(),
      capture: async () => {
        throw new Error("Must not capture on reopen");
      },
    });
    expect(storage.migration?.migrated).toBe(false);
    expect((await storage.artifacts.readFile(id, 1, "index.md")).toString()).toBe("# Shared");
    expect(await readdir(join(`${options().databasePath}.artifacts`, "backups"))).toEqual([]);
  });

  test("whole-artifact cleanup preserves shared originals and renderings until their last reference", async () => {
    storage = await openArtifactStorage(options());
    const first = storage.artifacts.create({ actor, kind: "files" }).id;
    const second = storage.artifacts.create({ actor, kind: "files" }).id;
    await storage.artifacts.publish(first, publication());
    await storage.artifacts.publish(second, publication());
    const file = storage.artifacts.file(second, 1, "index.md");
    storage.artifacts.delete(first);
    expect(await storage.collectBlobs()).toBe(0);
    expect((await storage.artifacts.readFile(second, 1, "index.md", true)).toString()).toBe(
      "<article># Shared</article>",
    );
    storage.artifacts.delete(second);
    expect(await storage.collectBlobs()).toBe(2);
    const blobs = new BlobStore(join(`${options().databasePath}.artifacts`, "blobs"));
    await expect(blobs.read(file.hash)).rejects.toThrow();
    await expect(blobs.read(file.renderedHash!)).rejects.toThrow();
  });

  test("startup reclaims interrupted upload bytes and migrates scratch assets once", async () => {
    const legacy = new Database(options().databasePath);
    legacy.exec(`CREATE TABLE reviews(id TEXT PRIMARY KEY, kind TEXT, source TEXT, status TEXT);
      INSERT INTO reviews VALUES ('review_scratch', 'files', '{"ref":"SCRATCH","files":[]}', 'open');`);
    legacy.close();
    await mkdir(join(root, "scratch/review_scratch"), { recursive: true });
    await writeFile(join(root, "scratch/review_scratch/index.md"), "# Current scratch");
    const blobs = new BlobStore(join(`${options().databasePath}.artifacts`, "blobs"));
    const orphan = await blobs.put("Abandoned before SQL commit");
    storage = await openArtifactStorage(options());
    expect(storage.migration?.migrated).toBe(true);
    expect(await Bun.file(storage.migration!.backupPath!).exists()).toBe(true);
    await expect(blobs.read(orphan.hash)).rejects.toThrow();
    await rm(join(root, "scratch"), { recursive: true });
    expect(
      (await storage.artifacts.readFile("review_scratch", 1, "review_scratch/index.md")).toString(),
    ).toBe("# Current scratch");
    expect(storage.artifacts.version("review_scratch", 1).provenance).toMatchObject({
      migration: { currentCapture: true },
    });
  });
});
