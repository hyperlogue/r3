import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactVersion } from "../shared/artifacts.ts";
import { readEventStream } from "../shared/event-stream.ts";
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
  api.close();
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

describe("artifact HTTP collaboration contract", () => {
  const human = { role: "human", sessionId: null };
  test("native threads, explicit reply context, owner delivery, and claims use the same IDs across HTTP", async () => {
    const id = await create();
    await request(`/api/artifacts/${id}/versions`, "POST", publication());
    const events = readEventStream((await request(`/api/events?artifact=${id}`)).body!);
    expect((await events.next()).value?.event).toBe("ready");
    const feedback = await (
      await request(`/api/artifacts/${id}/feedback`, "POST", {
        actor: human,
        body: "Please change this",
        target: {
          kind: "source",
          versionSeq: 1,
          path: "page.html",
          locator: { start: 1, end: 1, quote: "<h1>Original</h1>" },
        },
      })
    ).json();
    expect((await events.next()).value?.data).toContain(feedback.id);
    expect(
      (
        await request("/api/claims", "POST", {
          sessionId: actor.sessionId,
          feedbackIds: [feedback.id],
        })
      ).status,
    ).toBe(200);
    const preview = await request(`/api/artifacts/${id}/prompt?scope=unsent`);
    expect(preview.headers.get("x-r3-prompt-items")).toBe("1");
    expect((await (await request(`/api/feedback/${feedback.id}`)).json()).sentAt).toBeNull();
    const delivery = await request(`/api/artifacts/${id}/prompt`, "POST", {});
    expect(delivery.headers.get("x-r3-prompt-items")).toBe("1");
    expect(await delivery.text()).toContain('"versionSeq":1');
    expect(
      (await request(`/api/artifacts/${id}/prompt`, "POST", {})).headers.get("x-r3-prompt-items"),
    ).toBe("0");
    const reply = await request(`/api/feedback/${feedback.id}/replies`, "POST", {
      actor,
      body: "I inspected the published source",
      context: { versionSeq: 1, representation: "source" },
    });
    expect(reply.status).toBe(201);
    expect((await reply.json()).context).toEqual({ versionSeq: 1, representation: "source" });
    const current = await (await request(`/api/feedback/${feedback.id}`)).json();
    expect(current.claim).toBeNull();
    expect(current.status).toBe("open");
    expect(
      (await request(`/api/feedback/${feedback.id}`, "PATCH", { actor, status: "resolved" }))
        .status,
    ).toBe(400);
    expect(
      (await request(`/api/feedback/${feedback.id}`, "PATCH", { actor: human, status: "resolved" }))
        .status,
    ).toBe(200);
    await events.return(undefined);
  });

  test("archive commits before listener acknowledgment, reports failed delivery, and retries never notify again", async () => {
    const id = await create();
    const listening = await request(`/api/artifacts/${id}/listen`, "POST", { actor });
    const frames = readEventStream(listening.body!);
    const ready = JSON.parse((await frames.next()).value!.data);
    expect(ready.registration.kind).toBe("listen");
    expect((await (await request(`/api/artifacts/${id}`)).json()).watching).toBe(true);
    const command = {
      actor: human,
      event: "archived",
      operationKey: "archive-operation",
      message: "Saved next steps",
    };
    const archive = request(`/api/artifacts/${id}/lifecycle`, "POST", command);
    const nudge = JSON.parse((await frames.next()).value!.data).nudge;
    expect(nudge.message).toBe("Saved next steps");
    expect((await (await request(`/api/artifacts/${id}`)).json()).state).toBe("archived");
    expect(await (await request(`/api/artifacts/${id}/watchers`)).json()).toEqual([]);
    const acknowledged = await request(
      `/api/connections/${ready.registration.id}/acknowledgments`,
      "POST",
      { actor, nudgeId: nudge.id, ok: false, error: "Local harness unavailable" },
    );
    expect(acknowledged.status).toBe(200);
    const result = await archive;
    expect(result.status).toBe(502);
    expect((await result.json()).event.message).toBe(command.message);
    expect((await frames.next()).value?.event).toBe("closed");
    expect((await frames.next()).done).toBe(true);
    const retry = await request(`/api/artifacts/${id}/lifecycle`, "POST", command);
    expect((await retry.json()).notification.state).toBe("not_repeated");
    expect((await request(`/api/artifacts/${id}/submit`, "POST")).status).toBe(409);
    expect(
      (await (await request(`/api/artifacts/${id}/watch`, "POST", { actor })).json()).result,
    ).toBe("archived");
    await request(`/api/artifacts/${id}/lifecycle`, "POST", {
      actor: human,
      event: "restored",
      operationKey: "restore-operation",
    });
    expect(await (await request(`/api/artifacts/${id}/watchers`)).json()).toEqual([]);
  });

  test("watch shutdown releases the held slot and archived terminal state precedes pending feedback", async () => {
    const id = await create();
    const wait = request(`/api/artifacts/${id}/watch`, "POST", { actor, timeoutMs: 5000 });
    // Let the JSON request reader register the waiter before shutting down.
    while (!api.collaboration.watching(id)) await Bun.sleep(1);
    api.close();
    expect((await (await wait).json()).result).toBe("cancelled");
    expect(api.collaboration.watchers(id)).toEqual([]);
    await request(`/api/artifacts/${id}/feedback`, "POST", {
      actor: human,
      body: "Unsent content",
      target: { kind: "artifact" },
    });
    await request(`/api/artifacts/${id}/lifecycle`, "POST", {
      actor: human,
      event: "archived",
      operationKey: "silent-archive",
    });
    expect(
      (await (await request(`/api/artifacts/${id}/watch`, "POST", { actor })).json()).result,
    ).toBe("archived");
  });
});
