import { expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { R3_VERSION_HEADER } from "../shared/version.ts";
import { startArtifactServer } from "./artifact-server.ts";
import { openArtifactStorage } from "./artifact-storage.ts";

test("shared preview hosting preserves capability and application guards", async () => {
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
      files: new Map([
        [
          "/fixture.js",
          {
            body: new Blob(["/* fixture */"]),
            contentType: "text/javascript",
            etag: '"fixture-js"',
          },
        ],
      ]),
    },
    authentication: {
      token,
      requireLogin: true,
      version: "test",
      allowedHost: (host) => host === "localhost" || host === "reviews.example",
      applicationOrigins: new Set(["https://reviews.example"]),
    },
    bind: "127.0.0.1",
    port: 0,
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
    expect(publish.headers.get(R3_VERSION_HEADER)).toBe("test");
    const shell = await fetch(`${base}/${artifact.id}`);
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    expect(shell.headers.get(R3_VERSION_HEADER)).toBe("test");
    for (const [path, init, status] of [
      ["/fixture.js", {}, 200],
      ["/fixture.js", { headers: { "if-none-match": '"fixture-js"' } }, 304],
      ["/fixture.js", { method: "HEAD" }, 200],
      ["/missing.js", {}, 404],
      ["/api/artifacts", {}, 401],
      ["/api/boot", { headers: { origin: "null" } }, 403],
      ["/", { headers: { host: "untrusted.example" } }, 403],
    ] as const) {
      const response = await fetch(base + path, init);
      expect(response.status).toBe(status);
      expect(response.headers.get(R3_VERSION_HEADER)).toBe("test");
      await response.body?.cancel();
    }
    const stream = await fetch(`${base}/api/events`, { headers: { "x-r3-token": token } });
    expect(stream.headers.get(R3_VERSION_HEADER)).toBe("test");
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    await reader.cancel();
    expect(
      ((await (await fetch(`${base}/api/health`)).json()) as { protocol: string }).protocol,
    ).toBe("artifacts-v3");
    const preview = runtime.previews.create(artifact.id, 1, "index.html", base);
    expect(preview.origin).toBe(base);
    const read = (url: string, init: RequestInit = {}) =>
      fetch(base + new URL(url).pathname, {
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
    expect(gate.headers.get(R3_VERSION_HEADER)).toBe("test");
    expect(gate.headers.has("set-cookie")).toBe(false);
    const content = await read(preview.documentUrl, { headers: { "sec-fetch-dest": "iframe" } });
    expect(content.status).toBe(200);
    expect(content.headers.get(R3_VERSION_HEADER)).toBe("test");
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
    const failedPreview = spyOn(runtime.previews, "fetch").mockRejectedValueOnce(
      new Error("internal fixture failure"),
    );
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = await read(preview.gateUrl);
      expect(failure.status).toBe(500);
      expect(failure.headers.get(R3_VERSION_HEADER)).toBe("test");
      expect(failure.headers.get("cache-control")).toBe("no-store");
      expect(await failure.text()).toBe("Internal server error");
    } finally {
      failedPreview.mockRestore();
      logged.mockRestore();
    }
  } finally {
    await runtime.stop();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("default no-login mode refuses requests forwarded by an unconfigured proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-proxied-"));
  const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
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
      token: randomBytes(32).toString("base64url"),
      requireLogin: false,
      refuseProxied: true,
      version: "test",
      allowedHost: (host) => host === "localhost",
    },
    bind: "127.0.0.1",
    port: 0,
  });
  const base = `http://localhost:${runtime.server.port}`;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await fetch(`${base}/api/artifacts`)).status).toBe(200);
    for (const header of ["x-forwarded-for", "forwarded", "x-forwarded-host", "via"])
      for (const path of ["/api/artifacts", "/api/boot", "/", "/__r3_preview/x/"]) {
        const response = await fetch(`${base}${path}`, { headers: { [header]: "203.0.113.7" } });
        expect({ header, path, status: response.status }).toEqual({ header, path, status: 403 });
        const body = path.startsWith("/api/")
          ? ((await response.json()) as { error: string }).error
          : await response.text();
        expect(body).toContain("r3 config set publicUrl");
      }
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
    await runtime.stop();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
