import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactVersion } from "../shared/artifacts.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { artifactJson } from "./artifact-http.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let api: ReturnType<typeof createArtifactApi>;
let token: string;
const actor = { role: "agent", sessionId: "publisher-session" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-artifact-api-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    render: async () => ({ html: "<h1>Retained document</h1>", revision: "api-test" }),
  });
  token = randomBytes(32).toString("base64url");
  api = createArtifactApi(storage, {
    token,
    version: "test",
    requireLogin: false,
    allowedHost: (host) => host === "localhost",
  });
  await request("/api/sessions", "POST", { id: actor.sessionId, harness: "any-agent" });
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});
function request(path: string, method = "GET", body?: unknown, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("host", "localhost");
  headers.set("x-r3-token", token);
  if (body !== undefined) headers.set("content-type", "application/json");
  return api.app.request(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
async function create(kind = "files") {
  const response = await request("/api/artifacts", "POST", {
    kind,
    actor,
    title: "Published content",
  });
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}
function publication(expectedSeq = 0, publicationKey = "first") {
  return {
    actor,
    expectedSeq,
    publicationKey,
    content: {
      kind: "files",
      files: [
        {
          path: "page.html",
          mediaType: "text/html",
          base64: Buffer.from("<h1>Original</h1>").toString("base64"),
        },
        {
          path: "doc.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Original").toString("base64"),
        },
        {
          path: "assets/data.bin",
          mediaType: "application/octet-stream",
          base64: Buffer.from([0, 255, 42, 7]).toString("base64"),
        },
      ],
    },
  };
}

describe("artifact HTTP content contract", () => {
  test("publishes complete remote bytes, reads only retained versions, and never executes app-origin HTML", async () => {
    const id = await create();
    const base = `/api/artifacts/${id}/versions`;
    expect((await request(base, "POST", publication())).status).toBe(201);
    const binary = await request(`${base}/1/resource?path=assets%2Fdata.bin`, "GET", undefined, {
      range: "bytes=1-2",
    });
    expect(binary.status).toBe(206);
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(new Uint8Array([255, 42]));
    const html = await request(`${base}/1/resource?path=page.html`);
    expect(html.headers.get("content-disposition")).toStartWith("attachment;");
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(await html.text()).toBe("<h1>Original</h1>");
    const head = await request(`${base}/1/resource?path=page.html`, "HEAD");
    expect(head.headers.get("content-length")).toBe("17");
    expect(await head.text()).toBe("");
    const source = await (await request(`${base}/1/source?path=doc.md`)).json();
    expect(source.lines[0].text).toBe("# Original");
    expect(source.lines[0].html).not.toContain("<h1>");
    const second = publication(1, "second");
    second.content.files = [{ path: "new.txt", mediaType: "text/plain", base64: "" }];
    expect((await request(base, "POST", second)).status).toBe(201);
    expect((await request(`${base}/2/resource?path=page.html`)).status).toBe(404);
    expect((await request(`${base}/1/resource?path=page.html`)).status).toBe(200);
    expect((await request(`${base}/1`, "DELETE")).status).toBe(404);
    expect((await request(`${base}/01`)).status).toBe(400);
    expect((await request(`${base}/1/resource?path=..%2Fsecret`)).status).toBe(400);
    expect((await request(`${base}/1/resource?path=missing.html`)).status).toBe(404);
  });

  test("retry identity, concurrent publication, cache validators, and explicit grouping cross the HTTP boundary", async () => {
    const id = await create();
    const base = `/api/artifacts/${id}/versions`;
    const first = (await (await request(base, "POST", publication())).json()) as ArtifactVersion;
    expect(await (await request(base, "POST", publication())).json()).toEqual(first);
    const responses = await Promise.all([
      request(base, "POST", publication(1, "next-a")),
      request(base, "POST", publication(1, "next-b")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const detail = await request(`/api/artifacts/${id}`);
    expect((await detail.json()).versions).toHaveLength(2);
    expect(
      (
        await request(`/api/artifacts/${id}`, "GET", undefined, {
          "if-none-match": detail.headers.get("etag")!,
        })
      ).status,
    ).toBe(304);
    expect((await request(`/api/artifacts/${id}`, "PATCH", { title: "New title" })).status).toBe(
      200,
    );
    expect(
      (
        await request(`/api/artifacts/${id}`, "GET", undefined, {
          "if-none-match": detail.headers.get("etag")!,
        })
      ).status,
    ).toBe(200);
    expect((await request("/api/artifacts?state=approved")).status).toBe(400);
    const project = await (
      await request("/api/projects", "POST", { name: "Optional group" })
    ).json();
    const grouped = await (
      await request("/api/artifacts", "POST", { kind: "files", actor, projectId: project.id })
    ).json();
    expect(
      (await (await request(`/api/artifacts?project=${project.id}`)).json()).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([grouped.id]);
    await request(`/api/projects/${project.id}`, "DELETE");
    expect((await (await request(`/api/artifacts/${grouped.id}`)).json()).projectId).toBeNull();
  });

  test("sparse diff context never consults a repository and unsupported content has no fallback", async () => {
    const id = await create("diff");
    const base = `/api/artifacts/${id}/versions`;
    const patch =
      "diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -3,3 +3,3 @@\n retained\n-before\n+after\n end\n";
    expect(
      (
        await request(base, "POST", {
          actor,
          expectedSeq: 0,
          publicationKey: "patch",
          content: { kind: "diff", patch },
        })
      ).status,
    ).toBe(201);
    expect(
      (await (await request(`${base}/1/diff`)).json())[0].lines.some(
        (row: { oldLine: number }) => row.oldLine === 4,
      ),
    ).toBe(true);
    expect((await request(`${base}/1/diff-context?path=code.txt&start=3&end=3`)).status).toBe(200);
    expect((await request(`${base}/1/diff-context?path=code.txt&start=1&end=3`)).status).toBe(404);
    expect((await request(`${base}/1/source?path=code.txt`)).status).toBe(404);
    expect(await (await request(`${base}/1/patch`)).text()).toBe(patch);
  });
});

test("JSON input counts real streamed bytes and rejects malformed text", async () => {
  const request = (chunks: Uint8Array[]) =>
    new Request("http://localhost/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
  await expect(
    artifactJson(request([new TextEncoder().encode('{"title":"oversize"}')]), 8),
  ).rejects.toMatchObject({ status: 413 });
  await expect(artifactJson(request([new Uint8Array([123, 255, 125])]))).rejects.toMatchObject({
    status: 400,
  });
});
