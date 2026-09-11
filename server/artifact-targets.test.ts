import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactTables } from "./artifact-schema.ts";
import { ArtifactTargets, targetColumns, targetFromColumns } from "./artifact-targets.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";

let root: string;
let db: Database;
let artifacts: ArtifactStore;
let targets: ArtifactTargets;
const actor = { role: "human", sessionId: null } as const;
const file = (path: string, text: string, mediaType = "text/plain") => ({
  path,
  mediaType,
  base64: Buffer.from(text).toString("base64"),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-targets-"));
  db = new Database(":memory:");
  createArtifactTables(db);
  artifacts = new ArtifactStore(db, new BlobStore(root), async (text) => ({
    html: `<p>${text}</p>`,
    revision: "test",
  }));
  targets = new ArtifactTargets(artifacts);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("native artifact targets", () => {
  test("source quotes validate against the explicitly selected version and exact range", async () => {
    const id = artifacts.create({ kind: "files", actor }).id;
    await artifacts.publish(id, {
      actor,
      expectedSeq: 0,
      publicationKey: "one",
      content: { kind: "files", files: [file("doc.md", "# Title\n\nOld [label](next.md)\n")] },
    });
    await artifacts.publish(id, {
      actor,
      expectedSeq: 1,
      publicationKey: "two",
      content: { kind: "files", files: [file("doc.md", "# Title\n\nNew paragraph\n")] },
    });
    const target = {
      kind: "source" as const,
      versionSeq: 1,
      path: "doc.md",
      locator: { start: 3, end: 3, quote: "Old [label](next.md)" },
    };
    const validated = await targets.target(id, target);
    expect(validated).toEqual(target);
    expect(targetFromColumns(targetColumns(validated))).toEqual(target);
    await expect(targets.target(id, { ...target, versionSeq: 2 })).rejects.toThrow(
      "captured source",
    );
    await expect(
      targets.target(id, { ...target, locator: { ...target.locator, start: 2 } }),
    ).rejects.toThrow("captured source");
    await expect(targets.target(id, { ...target, versionSeq: null })).rejects.toThrow(
      "explicit integer",
    );
  });

  test("dynamic rendered evidence stays native and does not acquire source coordinates", async () => {
    const id = artifacts.create({ kind: "html", actor }).id;
    await artifacts.publish(id, {
      actor,
      expectedSeq: 0,
      publicationKey: "one",
      content: { kind: "html", files: [file("index.html", "<div id='app'></div>", "text/html")] },
    });
    const target = await targets.target(id, {
      kind: "rendered",
      versionSeq: 1,
      path: "index.html",
      locator: {
        selector: "#chart > button",
        quote: "  Generated\nchart\u00a0label ",
        prefix: " Before  ",
        route: "#chart",
        viewport: { width: 800, height: 600 },
        start: 99,
        end: 100,
      },
    });
    expect(target).toEqual({
      kind: "rendered",
      versionSeq: 1,
      path: "index.html",
      locator: {
        selector: "#chart > button",
        quote: "Generated chart label",
        prefix: "Before",
        route: "#chart",
        viewport: { width: 800, height: 600 },
      },
    });
    await expect(
      targets.target(id, { kind: "source", versionSeq: 1, path: "index.html", locator: null }),
    ).rejects.toThrow("incompatible");
    await expect(
      targets.target(id, {
        ...target,
        locator: { selector: "#app", route: "https://example.invalid/" },
      }),
    ).rejects.toThrow("document-local");
  });

  test("diff targets require their own side and cannot bridge uncaptured rows", async () => {
    const id = artifacts.create({ kind: "diff", actor }).id;
    const patch =
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-old\n+new\n@@ -10,1 +10,1 @@\n-before\n+after\n";
    await artifacts.publish(id, {
      actor,
      expectedSeq: 0,
      publicationKey: "one",
      content: { kind: "diff", patch },
    });
    const target = {
      kind: "diff" as const,
      versionSeq: 1,
      path: "a",
      locator: { side: "old" as const, start: 1, end: 1, quote: "old" },
    };
    expect(await targets.target(id, target)).toEqual(target);
    await expect(
      targets.target(id, { ...target, locator: { ...target.locator, side: "new" } }),
    ).rejects.toThrow("captured source");
    await expect(
      targets.target(id, {
        ...target,
        locator: { ...target.locator, end: 10, quote: "old\nbefore" },
      }),
    ).rejects.toThrow("gap");
  });

  test("reply context and unavailable placements remain explicit", async () => {
    const id = artifacts.create({ kind: "files", actor }).id;
    await artifacts.publish(id, {
      actor,
      expectedSeq: 0,
      publicationKey: "one",
      content: { kind: "files", files: [file("a", "text")] },
    });
    expect(targets.context(id, { versionSeq: null, representation: null })).toEqual({
      versionSeq: null,
      representation: null,
    });
    expect(targets.context(id, { versionSeq: 1, representation: "source" })).toEqual({
      versionSeq: 1,
      representation: "source",
    });
    expect(() => targets.context(id, { versionSeq: null, representation: "source" })).toThrow();
    expect(() => targets.context(id, { versionSeq: 1, representation: "diff" })).toThrow(
      "incompatible",
    );
    expect(() => targets.context(id, { versionSeq: 2, representation: "source" })).toThrow(
      "not found",
    );
    const missing = { kind: "source" as const, versionSeq: 1, path: "missing", locator: null };
    await expect(targets.target(id, missing)).rejects.toThrow("absent");
    expect(await targets.target(id, missing, true)).toEqual(missing);
    const other = artifacts.create({ kind: "files", actor }).id;
    await expect(
      targets.target(other, { kind: "source", versionSeq: 1, path: "a", locator: null }),
    ).rejects.toThrow("not found");
  });
});
