import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactResourceResponse } from "./artifact-resources.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let id: string;
const actor = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-resources-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    render: async () => ({ html: "<h1>Retained</h1>", revision: "resource-test" }),
  });
  id = storage.artifacts.create({ kind: "files", actor }).id;
  await storage.artifacts.publish(id, {
    actor,
    publicationKey: "first",
    expectedSeq: 0,
    content: {
      kind: "files",
      files: [
        {
          path: "media.bin",
          mediaType: "application/octet-stream",
          base64: Buffer.from([0, 255, 128, 3, 4, 5]).toString("base64"),
        },
        {
          path: "index.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Retained").toString("base64"),
        },
        {
          path: "page.html",
          mediaType: "text/html",
          base64: Buffer.from("<p>Page</p>").toString("base64"),
        },
      ],
    },
  });
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});
function response(path = "media.bin", headers?: HeadersInit, method = "GET", rendered = false) {
  return artifactResourceResponse(
    storage.artifacts,
    new Request("http://localhost/resource", { headers, method }),
    id,
    1,
    path,
    { rendered },
  );
}

describe("published resource responses", () => {
  test("serves exact binary bytes, HEAD metadata and private validators", async () => {
    const full = await response();
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(
      Uint8Array.from([0, 255, 128, 3, 4, 5]),
    );
    expect(full.headers.get("cache-control")).toContain("private");
    const head = await response("media.bin", undefined, "HEAD");
    expect(head.headers.get("content-length")).toBe("6");
    expect(await head.text()).toBe("");
    const unchanged = await response("media.bin", {
      "if-none-match": `W/${full.headers.get("etag")}`,
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  test("supports closed, open and suffix byte ranges and honors If-Range", async () => {
    for (const [range, expected, contentRange] of [
      ["bytes=1-2", [255, 128], "bytes 1-2/6"],
      ["bytes=4-", [4, 5], "bytes 4-5/6"],
      ["bytes=-2", [4, 5], "bytes 4-5/6"],
    ] as const) {
      const partial = await response("media.bin", { range });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(contentRange);
      expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([...expected]);
    }
    for (const range of ["bytes=6-", "bytes=3-1", "bytes=-0", "bytes=0-1,3-4"]) {
      const rejected = await response("media.bin", { range });
      expect(rejected.status).toBe(416);
      expect(rejected.headers.get("content-range")).toBe("bytes */6");
    }
    const etag = (await response("media.bin", undefined, "HEAD")).headers.get("etag")!;
    expect((await response("media.bin", { range: "bytes=0-1", "if-range": etag })).status).toBe(
      206,
    );
    expect((await response("media.bin", { range: "bytes=0-1", "if-range": '"old"' })).status).toBe(
      200,
    );
    expect((await response("media.bin", { range: "bytes=0-1" }, "HEAD")).status).toBe(200);
  });

  test("application-origin HTML is an attachment and retained Markdown uses rendered byte metadata", async () => {
    for (const [path, rendered] of [
      ["page.html", false],
      ["index.md", true],
    ] as const) {
      const result = await response(path, undefined, "GET", rendered);
      expect(result.headers.get("content-disposition")).toStartWith("attachment;");
      expect(result.headers.get("content-security-policy")).toContain("sandbox");
      expect(result.headers.get("content-type")).toStartWith("text/html");
      expect(Buffer.byteLength(await result.text())).toBe(
        Number(result.headers.get("content-length")),
      );
    }
    await expect(response("absent.js")).rejects.toMatchObject({ status: 404 });
    await expect(response("../page.html")).rejects.toThrow("canonical relative paths");
  });
});
