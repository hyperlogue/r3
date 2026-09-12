import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArtifactServer } from "./artifact-server.ts";
import { openArtifactStorage } from "./artifact-storage.ts";

test("application and preview listeners enforce distinct hosts, routes, and credentials", async () => {
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
    authentication: { token, requireLogin: false, version: "test", allowedHost: () => true },
    bind: "127.0.0.1",
    port: 0,
    previewPort: 0,
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
    // A shared hostname does not make the opaque document an application client.
    for (const origin of [preview.origin, "null"])
      expect((await fetch(`${base}/api/boot`, { headers: { origin } })).status).toBe(403);
    const previewBase = `http://localhost:${runtime.previewServer.port}`;
    expect(
      (
        await fetch(`${previewBase}/api/boot`, {
          headers: { host: new URL(preview.origin).host, "x-r3-token": token },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${previewBase}/files/index.html`, {
          headers: { host: new URL(preview.origin).host, "x-r3-token": token },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${previewBase}/`, { headers: { "x-r3-token": token } })).status).toBe(404);
    expect((await fetch(`${base}/files/index.html`)).status).toBe(404);
  } finally {
    await runtime.stop();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
