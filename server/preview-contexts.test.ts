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
  expect(() => local.create(id, 1, "notes/a # b?.md", context.origin)).toThrow("cannot host");
  const kept = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  storage.artifacts.delete(id);
  expect(() => contexts.forRequest(request(kept.documentUrl))).toThrow();
});

test("a null origin is not authorization; the gate proof is browser-bound, single-use, and expiring", () => {
  const context = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  const browser = (method = "GET", extra: Record<string, string> = {}) =>
    new Request(context.gateUrl, {
      method,
      headers: { host: new URL(context.origin).host, "user-agent": "Browser A", ...extra },
    });
  const proof = contexts.challenge(browser());
  const post = browser("POST", { origin: "null", "content-type": "application/json" });
  expect(contexts.authorized(browser())).toBeNull();
  expect(contexts.verify(post, "unknown")).toBe(false);
  expect(
    contexts.verify(
      browser("POST", { origin: context.origin, "content-type": "application/json" }),
      proof.challenge,
    ),
  ).toBe(false);
  expect(
    contexts.verify(
      browser("POST", { origin: "null", "content-type": "text/plain" }),
      proof.challenge,
    ),
  ).toBe(false);
  expect(
    contexts.verify(
      browser("POST", {
        origin: "null",
        "content-type": "application/json",
        "user-agent": "Browser B",
      }),
      proof.challenge,
    ),
  ).toBe(false);
  expect(contexts.verify(post, proof.challenge)).toBe(true);
  expect(contexts.verify(post, proof.challenge)).toBe(false);
  expect(contexts.authorized(browser())?.versionSeq).toBe(1);
  expect(contexts.authorized(browser("GET", { "user-agent": "Browser B" }))).toBeNull();
  // Opaque resource requests omit client hints; no shared cookie or storage is needed.
  expect(
    contexts.authorized(browser("GET", { "sec-ch-ua": '"Fixture";v="153"' }))?.versionSeq,
  ).toBe(1);
  contexts.renew(context.id);
  expect(contexts.authorized(browser())?.versionSeq).toBe(1);
  const next = contexts.challenge(browser());
  time += 120_001;
  expect(contexts.verify(post, next.challenge)).toBe(false);
  contexts.revoke(context.id);
  expect(() => contexts.authorized(browser())).toThrow("unavailable");
});
