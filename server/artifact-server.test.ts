import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArtifactServer } from "./artifact-server.ts";
import { openArtifactStorage } from "./artifact-storage.ts";

test.each([
  "automatic",
  "explicit",
])("%s preview hosting preserves capability and application guards", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "r3-servers-"));
  const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  const token = randomBytes(32).toString("base64url");
  const runtime = startArtifactServer({
    storage,
    assets: {
      index: {
        body: new Blob(["<!doctype html><title>r3</title>"]),
        contentType: "text/html",
        etag: '"fixture"',
      },
      files: new Map(),
    },
    authentication: {
      token,
      requireLogin: false,
      version: "test",
      allowedHost: (host) => host === "localhost" || host === "reviews.example",
      applicationOrigins: new Set(["https://reviews.example"]),
    },
    bind: "127.0.0.1",
    port: 0,
    previewPort: 0,
    ...(mode === "explicit" ? { previewBaseUrl: "https://preview.example" } : {}),
  });
  const base = `http://localhost:${runtime.server.port}`;
  try {
    const actor = { role: "human", sessionId: null };
    const create = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { "x-r3-token": token, "content-type": "application/json" },
      body: JSON.stringify({ kind: "html", actor }),
    });
    const artifact = (await create.json()) as { id: string };
    const publish = await fetch(`${base}/api/artifacts/${artifact.id}/versions`, {
      method: "POST",
      headers: { "x-r3-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        actor,
        expectedSeq: 0,
        publicationKey: "fixture",
        content: {
          kind: "html",
          files: [
            {
              path: "index.html",
              mediaType: "text/html",
              base64: Buffer.from("<h1>Private artifact</h1>").toString("base64"),
            },
          ],
        },
      }),
    });
    expect(publish.status).toBe(201);
    const shell = await fetch(`${base}/${artifact.id}`);
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    expect(
      ((await (await fetch(`${base}/api/health`)).json()) as { protocol: string }).protocol,
    ).toBe("artifacts-v1");
    const preview = runtime.previews.create(artifact.id, 1, "index.html", base);
    expect(preview.origin).toBe(mode === "automatic" ? base : "https://preview.example");
    expect(!!runtime.previewServer).toBe(mode === "explicit");
    const endpoint =
      mode === "automatic" ? base : `http://localhost:${runtime.previewServer!.port}`;
    const read = (url: string, init: RequestInit = {}) =>
      fetch(endpoint + new URL(url).pathname, {
        ...init,
        headers: {
          host: new URL(preview.origin).host,
          "user-agent": "Preview browser",
          ...init.headers,
        },
      });
    // Application credentials never substitute for a valid preview capability.
    const unknown = preview.documentUrl.replace(preview.id, `p${randomBytes(24).toString("hex")}`);
    expect((await read(unknown, { headers: { "x-r3-token": token, origin: "null" } })).status).toBe(
      404,
    );
    const gate = await read(preview.gateUrl);
    expect(gate.status).toBe(200);
    expect(gate.headers.has("set-cookie")).toBe(false);
    const content = await read(preview.documentUrl, { headers: { "sec-fetch-dest": "iframe" } });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
    expect(content.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(await content.text()).toContain("Private artifact");
    expect(
      (await fetch(`${base}/api/boot`, { headers: { origin: "null", "x-r3-token": token } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/artifacts`, { headers: { origin: "null", "x-r3-token": token } }))
        .status,
    ).toBe(403);
    expect((await fetch(`${base}/`, { headers: { host: "untrusted.example" } })).status).toBe(403);
    expect((await read(`${preview.resourceRoot}../../api/boot`)).status).toBe(404);
    expect((await fetch(`${base}/files/index.html`)).status).toBe(404);
    if (mode === "explicit") {
      expect(
        (await fetch(`${endpoint}/api/boot`, { headers: { "x-r3-token": token } })).status,
      ).toBe(404);
      expect((await fetch(`${endpoint}/`, { headers: { "x-r3-token": token } })).status).toBe(404);
    } else {
      // The authenticated Origin chooses the existing HTTPS edge even when the
      // reverse proxy rewrites Host to the loopback application listener.
      const created = await fetch(`${base}/api/artifacts/${artifact.id}/versions/1/previews`, {
        method: "POST",
        headers: {
          "x-r3-token": token,
          "content-type": "application/json",
          origin: "https://reviews.example",
        },
        body: JSON.stringify({ path: "index.html" }),
      });
      expect(created.status).toBe(201);
      const remote = (await created.json()) as { origin: string; gateUrl: string };
      expect(remote.origin).toBe("https://reviews.example");
      const remotePath = new URL(remote.gateUrl).pathname;
      expect((await fetch(base + remotePath)).status).toBe(200);
      expect(
        (
          await fetch(base + remotePath, {
            headers: { host: "untrusted.example", "x-forwarded-host": "reviews.example" },
          })
        ).status,
      ).toBe(403);
    }
  } finally {
    await runtime.stop();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
