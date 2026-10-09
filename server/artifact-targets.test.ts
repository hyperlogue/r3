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
    const excerpt = { ...target, locator: { ...target.locator, start: 2 } };
    expect(await targets.target(id, excerpt)).toEqual(excerpt);
    await expect(
      targets.target(id, { ...target, locator: { start: 1, end: 2, quote: "Old" } }),
    ).rejects.toThrow("captured source");
    await expect(targets.target(id, { ...target, versionSeq: null })).rejects.toThrow(
      "explicit integer",
    );
  });

  test("compact quotes match within a complete captured range without relaxing range bounds", async () => {
    const id = artifacts.create({ kind: "files", actor }).id;
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}  `);
    await artifacts.publish(id, {
      actor,
      expectedSeq: 0,
      publicationKey: "range",
      content: { kind: "files", files: [file("source.txt", `${lines.join("\r\n")}\r\n`)] },
    });
    const target = {
      kind: "source" as const,
      versionSeq: 1,
      path: "source.txt",
      locator: { start: 7, end: 13, quote: lines.slice(6, 10).join("\n") },
    };
    expect(await targets.target(id, target)).toEqual(target);
    expect((await targets.sourceRange(id, target)).text).toBe(lines.slice(6, 13).join("\n"));
    for (const quote of ["line 10", "7  \nline 8", lines.slice(6, 13).join("\n")])
      expect(
        await targets.target(id, { ...target, locator: { ...target.locator, quote } }),
      ).toBeDefined();
    for (const locator of [
      { start: 7, end: 13, quote: "line 14" },
      { start: 7, end: 13, quote: "line 7  \nline 9" },
      { start: 99, end: 101, quote: "line 99" },
      { start: 0, end: 13, quote: "line 7" },
      { start: 1, end: 101, quote: "line 7" },
      { start: 7, end: 13, quote: "" },
      { start: 7, end: 13, quote: "x".repeat(16_385) },
    ])
      await expect(targets.target(id, { ...target, locator })).rejects.toThrow();
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
        label: "  Chart\nsettings  ",
        quote: "  Generated\nchart\u00a0label ",
        prefix: " Before  ",
        route: "#chart",
        viewport: { width: 800, height: 200_000 },
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
        label: "Chart settings",
        quote: "Generated chart label",
        prefix: "Before",
        route: "#chart",
        viewport: { width: 800, height: 200_000 },
      },
    });
    expect(targetFromColumns(targetColumns(target))).toEqual(target);
    for (const label of ["", "  ", 42, null, "x".repeat(201)]) {
      await expect(
        targets.target(id, { ...target, locator: { selector: "#app", label } }),
      ).rejects.toThrow("label must be nonempty text");
    }
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
        locator: { ...target.locator, end: 10, quote: "old" },
      }),
    ).rejects.toThrow("gap");
  });

  test("unavailable placements stay native to their artifact", async () => {
    const id = artifacts.create({ kind: "files", actor }).id;
    await artifacts.publish(id, {
      actor,
      expectedSeq: 0,
      publicationKey: "one",
      content: { kind: "files", files: [file("a", "text")] },
    });
    const missing = { kind: "source" as const, versionSeq: 1, path: "missing", locator: null };
    await expect(targets.target(id, missing)).rejects.toThrow("absent");
    expect(await targets.target(id, missing, true)).toEqual(missing);
    const other = artifacts.create({ kind: "files", actor }).id;
    await expect(
      targets.target(other, { kind: "source", versionSeq: 1, path: "a", locator: null }),
    ).rejects.toThrow("not found");
  });
});
