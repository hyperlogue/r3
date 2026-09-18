import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import {
  PreviewContexts,
  previewDocumentUrl,
  previewPolicy,
  previewRoot,
} from "./preview-contexts.ts";

let root: string;
let storage: ArtifactStorage;
let id: string;
let time: number;
let contexts: PreviewContexts;
const actor = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-preview-contexts-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    render: async () => ({ html: "<h1>Retained</h1>", revision: "preview-fixture" }),
  });
  id = storage.artifacts.create({ kind: "files", actor }).id;
  for (const seq of [1, 2])
    await storage.artifacts.publish(id, {
      actor,
      publicationKey: `publication-${seq}`,
      expectedSeq: seq - 1,
      content: {
        kind: "files",
        files: [
          {
            path: "notes/a # b?.md",
            mediaType: "text/markdown",
            base64: Buffer.from(`# Version ${seq}`).toString("base64"),
          },
          {
            path: "data.json",
            mediaType: "application/json",
            base64: Buffer.from("{}").toString("base64"),
          },
        ],
      },
    });
  time = Date.parse("2026-09-11T12:00:00Z");
  contexts = new PreviewContexts(storage.artifacts, "https://preview.example", () => time);
});
afterEach(async () => {
  contexts.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
const request = (url: string) => new Request(url, { headers: { host: new URL(url).host } });

test("each preview grants one publication through an exact, temporary capability path", () => {
  const first = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  const second = contexts.create(id, 2, "notes/a # b?.md", "https://app.example");
  expect(first.origin).toBe(second.origin);
  expect(first.resourceRoot).not.toBe(second.resourceRoot);
  expect(contexts.forRequest(request(first.documentUrl)).versionSeq).toBe(1);
  expect(contexts.forRequest(request(second.documentUrl)).versionSeq).toBe(2);
  expect(first.documentUrl.endsWith("/files/notes/a%20%23%20b%3F.md")).toBe(true);
  expect(() =>
    contexts.forRequest(
      request(first.documentUrl.replace("preview.example", "preview.example:444")),
    ),
  ).toThrow("unavailable");
  expect(() =>
    contexts.forRequest(request(first.documentUrl.replace("preview.example", "other.example"))),
  ).toThrow("unavailable");
  expect(() => contexts.forRequest(new Request(first.documentUrl))).toThrow("unavailable");
  expect(() => contexts.create(id, 1, "data.json", "https://app.example")).toThrow(
    "rendered document",
  );
  expect(() => previewDocumentUrl(first, "../data.json")).toThrow();
  time += 30 * 60 * 1000;
  const renewed = contexts.renew(first.id);
  expect(Date.parse(renewed.expiresAt)).toBe(time + 60 * 60 * 1000);
  time += 31 * 60 * 1000;
  expect(() => contexts.forRequest(request(second.documentUrl))).toThrow("expired");
  expect(contexts.forRequest(request(first.documentUrl)).versionSeq).toBe(1);
  contexts.revoke(first.id);
  expect(() => contexts.forRequest(request(first.documentUrl))).toThrow("unavailable");
});

test("preview policies scope resources, forbid forms/redirects/WebRTC, and isolate document origins", () => {
  const context = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  expect(context.network).toBe("blocked");
  const scope = contexts.forRequest(request(context.documentUrl));
  const headers = previewPolicy(scope);
  const allowlist = headers.get("connection-allowlist")!;
  expect(allowlist).toBe(
    `("${previewRoot(scope)}/files/*" "${previewRoot(scope)}/r3/*"); webrtc=block; redirects=block`,
  );
  expect(headers.get("content-security-policy")).toContain("form-action 'none'");
  expect(headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(headers.get("permissions-policy")).toBe("camera=(), microphone=()");
  expect(headers.has("set-cookie")).toBe(false);
  // Header assertions prove configuration only; browser acceptance must prove enforcement.
  contexts.revokeArtifact(id);
  expect(() => contexts.forRequest(request(context.documentUrl))).toThrow("unavailable");
});

test("compatibility preserves restrictive policy and scoped immutable grants", () => {
  const blocked = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  const compatible = contexts.create(id, 1, "notes/a # b?.md", "https://app.example", "compatible");
  const blockedScope = contexts.forRequest(request(blocked.documentUrl));
  const scope = contexts.forRequest(request(compatible.documentUrl));
  expect(scope.network).toBe("compatible");
  expect(scope.id).not.toBe(blockedScope.id);
  // Both modes send the same restrictions; only blocked requires the browser
  // to prove network enforcement. No external-resource or device grant is added.
  const normalized = [...previewPolicy(scope)].map(([name, value]) => [
    name,
    value.replaceAll(scope.id, blockedScope.id),
  ]);
  expect(normalized).toEqual([...previewPolicy(blockedScope)]);
  expect(contexts.renew(compatible.id).network).toBe("compatible");
  expect(contexts.renew(blocked.id).network).toBe("blocked");
  contexts.revoke(compatible.id);
  expect(() => contexts.forRequest(request(compatible.documentUrl))).toThrow("unavailable");
});

test("external connections require an explicit HTML context and never relax an existing grant", async () => {
  expect(() =>
    contexts.create(id, 1, "notes/a # b?.md", "https://app.example", "external"),
  ).toThrow("Only HTML artifacts");
  const html = storage.artifacts.create({ kind: "html", actor });
  await storage.artifacts.publish(html.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "html",
    content: {
      kind: "html",
      files: [
        {
          path: "index.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Page").toString("base64"),
        },
      ],
    },
  });
  for (const invalid of [null, true, "allow", { network: "external" }])
    expect(() => contexts.create(html.id, 1, "index.md", "https://app.example", invalid)).toThrow(
      "Preview network",
    );
  const closed = contexts.create(html.id, 1, "index.md", "https://app.example");
  const external = contexts.create(html.id, 1, "index.md", "https://app.example", "external");
  expect(external.id).not.toBe(closed.id);
  expect(external.network).toBe("external");
  const headers = previewPolicy(contexts.forRequest(request(external.documentUrl)));
  expect(headers.has("connection-allowlist")).toBe(false);
  const csp = headers.get("content-security-policy")!;
  expect(csp).toContain("http: https: ws: wss:");
  for (const directive of [
    "sandbox allow-scripts",
    "worker-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors https://app.example",
  ])
    expect(csp).toContain(directive);
  expect(csp).not.toContain("allow-same-origin");
  expect(headers.get("permissions-policy")).toBe("camera=(), microphone=()");
  expect(contexts.renew(external.id).network).toBe("external");
  expect(contexts.renew(closed.id).network).toBe("blocked");
  expect(
    previewPolicy(contexts.forRequest(request(closed.documentUrl))).has("connection-allowlist"),
  ).toBe(true);
  contexts.revoke(external.id);
  expect(() => contexts.forRequest(request(external.documentUrl))).toThrow("unavailable");
});

test("preview origins require secure contexts and an explicit secure transport origin", () => {
  expect(() => new PreviewContexts(storage.artifacts, "http://preview.example")).toThrow("HTTPS");
  expect(() => new PreviewContexts(storage.artifacts, "http://127.preview.example")).toThrow(
    "HTTPS",
  );
  expect(() => new PreviewContexts(storage.artifacts, "https://preview.example/base")).toThrow(
    "URL path",
  );
  expect(() => new PreviewContexts(storage.artifacts, "http://127.0.0.1:8792")).not.toThrow();
  const local = new PreviewContexts(storage.artifacts, "http://localhost:8792");
  expect(() => local.create(id, 1, "notes/a # b?.md", "https://app.example")).toThrow(
    "R3_PREVIEW_BASE_URL",
  );
  const context = local.create(id, 1, "notes/a # b?.md", "http://localhost:8791");
  expect(new URL(context.origin).port).toBe("8792");
  expect(() => local.create(id, 1, "notes/a # b?.md", "http://127.0.0.1:8791")).not.toThrow();
  expect(() => local.create(id, 1, "notes/a # b?.md", "http://[::1]:8791")).not.toThrow();
  expect(() => local.create(id, 1, "notes/a # b?.md", context.origin)).not.toThrow();
  const kept = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  storage.artifacts.delete(id);
  expect(() => contexts.forRequest(request(kept.documentUrl))).toThrow();
});

test("automatic contexts use the authenticated application origin, including HTTPS and loopback", () => {
  const automatic = new PreviewContexts(storage.artifacts, undefined);
  for (const origin of [
    "https://reviews.example",
    "http://localhost:8791",
    "http://127.0.0.1:8791",
    "http://[::1]:8791",
  ]) {
    const context = automatic.create(id, 1, "notes/a # b?.md", origin);
    expect(context.origin).toBe(origin);
    expect(automatic.forRequest(request(context.gateUrl)).origin).toBe(origin);
    const proxy = new Request(`http://localhost:8791${new URL(context.gateUrl).pathname}`, {
      headers: { host: "localhost:8791" },
    });
    if (origin === "https://reviews.example") {
      expect(() => automatic.forRequest(proxy)).toThrow("unavailable");
      expect(automatic.forRequest(proxy, new Set([origin])).origin).toBe(origin);
      expect(() => automatic.forRequest(proxy, new Set(["https://other.example"]))).toThrow(
        "unavailable",
      );
    }
  }
  expect(() => automatic.create(id, 1, "notes/a # b?.md", "http://reviews.example")).toThrow(
    "HTTPS",
  );
  automatic.close();
});
