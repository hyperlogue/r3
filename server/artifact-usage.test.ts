import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

const actor = { role: "human", sessionId: null } as const;
let root: string, time: string, storage: ArtifactStorage;
const options = () => ({
  databasePath: join(root, "store.sqlite"),
  clock: () => time,
  timezone: "America/New_York",
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-usage-"));
  time = "2026-10-05T12:00:00.000Z";
  storage = await openArtifactStorage(options());
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});
const create = () => storage.artifacts.create({ kind: "files", actor });
const publish = (id: string, text: string, expectedSeq = 0) =>
  storage.artifacts.publish(id, {
    actor,
    expectedSeq,
    publicationKey: `version-${expectedSeq}`,
    content: {
      kind: "files",
      files: [
        { path: "test.txt", mediaType: "text/plain", base64: Buffer.from(text).toString("base64") },
      ],
    },
  });
const transition = (
  id: string,
  event: "archived" | "restored",
  operationKey = `${event}-${time}`,
) => storage.lifecycle.transition(id, { actor, event, operationKey });

test("global content and reclaimable content deduplicate across artifacts and versions", async () => {
  const first = create(),
    second = create();
  await publish(first.id, "shared");
  await publish(first.id, "only-first", 1);
  await publish(second.id, "shared");
  const note = await storage.conversations.add(first.id, {
    actor,
    body: "Discuss",
    target: { kind: "artifact" },
  });
  await storage.conversations.addComment(note.id, {
    actor,
    body: "Comment",
    context: { versionSeq: null, representation: null },
  });
  expect(storage.usage.stat()).toMatchObject({
    contentBytes: 16,
    artifacts: { total: 2, active: 2 },
    versions: 3,
    conversations: { open: 1, resolved: 0, comments: 2 },
  });
  transition(first.id, "archived");
  time = "2026-11-04T12:00:00.000Z";
  const preview = storage.usage.gc({ dryRun: true });
  expect(preview.candidates.map((row) => row.id)).toEqual([first.id]);
  expect(preview.reclaimableBytes).toBe(10);
  expect(storage.artifacts.list()).toHaveLength(2);
  const result = storage.usage.gc({ candidates: preview.candidates });
  expect(result.deletedIds).toEqual([first.id]);
  await storage.collectBlobs();
  expect(storage.usage.stat().contentBytes).toBe(6);
  expect((await storage.artifacts.readFile(second.id, 1, "test.txt")).toString()).toBe("shared");
});

test("TTL uses the archive instant, reaches equality, and ignores rejected writes", async () => {
  const artifact = create();
  transition(artifact.id, "archived");
  time = "2026-11-04T11:59:59.999Z";
  expect(() => storage.artifacts.edit(artifact.id, { title: "Recent edit" })).toThrow("archived");
  expect(storage.usage.gc({ dryRun: true }).candidates).toHaveLength(0);
  time = "2026-11-04T12:00:00.000Z";
  expect(storage.usage.gc({ dryRun: true }).candidates).toHaveLength(1);
  transition(artifact.id, "restored");
  expect(storage.usage.gc({ dryRun: true }).candidates).toHaveLength(0);
  transition(artifact.id, "archived");
  expect(storage.usage.gc({ dryRun: true }).candidates).toHaveLength(0);
  time = "2026-11-05T12:00:00.000Z";
  expect(storage.usage.gc({ dryRun: true, ttlDays: 1 }).candidates).toHaveLength(1);
});

test("confirmed cleanup skips restored/re-archived artifacts and excludes new eligible arrivals", () => {
  const first = create(),
    second = create();
  transition(first.id, "archived");
  time = "2026-10-06T12:00:00.000Z";
  transition(second.id, "archived");
  time = "2026-11-04T12:00:00.000Z";
  const preview = storage.usage.gc({ dryRun: true });
  transition(first.id, "restored");
  transition(first.id, "archived");
  time = "2026-12-05T12:00:00.000Z";
  const result = storage.usage.gc({ candidates: preview.candidates });
  expect(result.deletedIds).toEqual([]);
  expect(result.skippedIds).toEqual([first.id]);
  expect(storage.artifacts.list()).toHaveLength(2);
});

test("activity survives deletion and restart, while retries and rejected writes do not count", async () => {
  const artifact = create();
  await publish(artifact.id, "hello");
  await publish(artifact.id, "hello");
  await expect(publish(artifact.id, "conflict")).rejects.toThrow();
  const input = { actor, body: "Note", target: { kind: "artifact" }, operationKey: "note-once" };
  const note = await storage.conversations.add(artifact.id, input);
  await storage.conversations.add(artifact.id, input);
  await storage.conversations.addComment(note.id, {
    actor,
    body: "Answer",
    context: { versionSeq: null, representation: null },
  });
  storage.conversations.edit(note.id, { actor, status: "resolved" });
  expect(storage.usage.stat().conversations).toEqual({ open: 0, resolved: 1, comments: 2 });
  transition(artifact.id, "archived", "archive-once");
  transition(artifact.id, "archived", "archive-once");
  transition(artifact.id, "restored");
  const period = storage.usage.stat().periods.at(-1)!;
  expect(period).toMatchObject({
    artifactsCreated: 1,
    versionsPublished: 1,
    threadsAdded: 1,
    commentsAdded: 2,
    archived: 1,
    restored: 1,
  });
  storage.conversations.delete(note.id, actor);
  storage.artifacts.delete(artifact.id);
  storage.close();
  storage = await openArtifactStorage(options());
  expect(storage.usage.stat().periods.at(-1)).toEqual(period);
  expect(storage.usage.stat().artifacts.total).toBe(0);
});

test("calendar buckets use server timezone through DST and Monday boundaries", () => {
  time = "2026-11-01T03:59:59.000Z";
  create(); // October 31 locally.
  time = "2026-11-01T05:30:00.000Z";
  create(); // First 01:30.
  time = "2026-11-01T06:30:00.000Z";
  create(); // Repeated 01:30.
  time = "2026-11-02T04:59:59.000Z";
  create(); // Still Sunday locally.
  time = "2026-11-02T05:00:00.000Z";
  create(); // Monday midnight.
  const daily = storage.usage.stat();
  expect(daily.timezone).toBe("America/New_York");
  expect(daily.periods.slice(-3).map((p) => [p.start, p.artifactsCreated])).toEqual([
    ["2026-10-31", 1],
    ["2026-11-01", 3],
    ["2026-11-02", 1],
  ]);
  const weekly = storage.usage.stat("weekly");
  expect(weekly.periods).toHaveLength(4);
  expect(weekly.periods.slice(-2).map((p) => [p.start, p.artifactsCreated, p.partial])).toEqual([
    ["2026-10-26", 4, false],
    ["2026-11-02", 1, true],
  ]);
});

test("schema upgrade backfills retained history once and marks earlier coverage partial", async () => {
  const artifact = create();
  await publish(artifact.id, "retained");
  storage.close();
  const db = new Database(options().databasePath);
  for (const { name } of db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'activity_%'",
    )
    .all())
    db.exec(`DROP TRIGGER ${name}`);
  db.exec(
    "DROP TABLE artifact_activity; DROP TABLE artifact_activity_coverage; PRAGMA user_version=8",
  );
  db.close();
  time = "2026-10-06T12:00:00.000Z";
  storage = await openArtifactStorage(options());
  expect(storage.migration?.migrated).toBe(true);
  const stats = storage.usage.stat();
  expect(stats.completeSince).toBe(time);
  expect(stats.periods.at(-2)).toMatchObject({
    artifactsCreated: 1,
    versionsPublished: 1,
    incompleteHistory: true,
  });
  storage.artifacts.delete(artifact.id);
  storage.close();
  storage = await openArtifactStorage(options());
  expect(storage.usage.stat().periods).toEqual(stats.periods);
});

test("invalid cleanup input never deletes anything and configured TTL controls defaults", async () => {
  const artifact = create();
  transition(artifact.id, "archived");
  time = "2026-10-10T12:00:00.000Z";
  for (const ttlDays of [0, -1, 1.1, "1", null, 36501])
    expect(() => storage.usage.gc({ ttlDays })).toThrow();
  expect(() => storage.usage.gc({ dryRun: "false" })).toThrow();
  expect(() =>
    storage.usage.gc({ candidates: [{ id: artifact.id, archivedAt: "bad" }] }),
  ).toThrow();
  expect(storage.artifacts.list()).toHaveLength(1);
  storage.close();
  storage = await openArtifactStorage({ ...options(), archiveTtlDays: 5 });
  expect(storage.usage.stat().gc).toMatchObject({ ttlDays: 5, eligibleArtifacts: 1 });
});

test("one blob namespace covers discussions images and files, while patches count per publication", async () => {
  const image = {
    mediaType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=",
  };
  const first = create(),
    second = create();
  await storage.artifacts.publish(first.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "image",
    content: { kind: "files", files: [{ path: "image.png", ...image }] },
  });
  await storage.conversations.add(second.id, {
    actor,
    body: "Same bytes",
    target: { kind: "artifact" },
    attachments: [image],
  });
  const size = Buffer.from(image.base64, "base64").byteLength;
  expect(storage.usage.stat().contentBytes).toBe(size);
  transition(first.id, "archived");
  time = "2026-11-04T12:00:00.000Z";
  expect(storage.usage.gc({ dryRun: true }).reclaimableBytes).toBe(0);
  const diff = storage.artifacts.create({ kind: "diff", actor });
  const patch =
    "diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new\n";
  for (let expectedSeq = 0; expectedSeq < 2; expectedSeq++)
    await storage.artifacts.publish(diff.id, {
      actor,
      expectedSeq,
      publicationKey: `patch-${expectedSeq}`,
      content: { kind: "diff", patch },
    });
  expect(storage.usage.stat().contentBytes).toBe(size + Buffer.byteLength(patch) * 2);
});
