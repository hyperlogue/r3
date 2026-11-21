import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactFile } from "../shared/artifacts.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let api: ReturnType<typeof createArtifactApi>;
let token: string;
const actor = { role: "human", sessionId: null } as const;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-asset-relay-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    render: async () => ({ html: "<h1>Retained document</h1>", revision: "relay-test" }),
  });
  token = randomBytes(32).toString("base64url");
  api = createArtifactApi(storage, {
    token,
    version: "test",
    requireLogin: true,
    allowedHost: (host) => host === "localhost",
  });
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
const request = (path: string, headers: Record<string, string> = { "x-r3-token": token }) =>
  api.app.request(
    new Request(`http://localhost${path}`, { headers: { host: "localhost", ...headers } }),
  );
async function publish(path: string) {
  const { id } = storage.artifacts.create({ kind: "files", actor });
  await storage.artifacts.publish(id, {
    actor,
    expectedSeq: 0,
    publicationKey: "first",
    content: {
      kind: "files",
      files: [
        {
          path,
          mediaType: "model/example",
          base64: Buffer.from([0, 255, 42, 7]).toString("base64"),
        },
        {
          path: "doc.md",
          mediaType: "text/markdown",
          base64: Buffer.from(`# ${path}`).toString("base64"),
        },
      ],
    },
  });
  const files = storage.artifacts.files(id, 1);
  return { id, files: Object.fromEntries(files.map((file) => [file.path, file])) } as {
    id: string;
    files: Record<string, ArtifactFile>;
  };
}

test("a digest reads published bytes only while a retained version publishes them", async () => {
  const first = await publish("models/a.bin");
  const second = await publish("renamed/b.bin");
  const { hash } = first.files["models/a.bin"]!;
  expect(second.files["renamed/b.bin"]!.hash).toBe(hash);

  const response = await request(`/api/blobs/${hash}`);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 42, 7]));
  expect(response.headers.get("etag")).toBe(`"${hash}"`);
  expect(response.headers.get("cache-control")).toContain("immutable");
  // The digest carries no media type, and application-origin bytes never render.
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toStartWith("attachment;");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  const range = await request(`/api/blobs/${hash}`, { "x-r3-token": token, range: "bytes=1-2" });
  expect(range.status).toBe(206);
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array([255, 42]));

  expect((await request(`/api/blobs/${hash}`, {})).status).toBe(401);
  expect((await request(`/api/blobs/${hash.toUpperCase()}`)).status).toBe(400);
  expect((await request(`/api/blobs/${"0".repeat(64)}`)).status).toBe(404);
  const rendered = first.files["doc.md"]!.renderedHash!;
  expect(rendered).toMatch(/^[0-9a-f]{64}$/);
  expect((await request(`/api/blobs/${rendered}`)).status).toBe(404);

  storage.artifacts.delete(first.id);
  expect((await request(`/api/blobs/${hash}`)).status).toBe(200);
  expect((await request(`/api/blobs/${first.files["doc.md"]!.hash}`)).status).toBe(404);
  storage.artifacts.delete(second.id);
  expect((await request(`/api/blobs/${hash}`)).status).toBe(404);
});
