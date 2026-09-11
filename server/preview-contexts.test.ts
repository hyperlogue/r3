import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { PreviewContexts, previewDocumentUrl, previewPolicy } from "./preview-contexts.ts";

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

test("each preview grants one publication through an exact, temporary capability origin", () => {
  const first = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  const second = contexts.create(id, 2, "notes/a # b?.md", "https://app.example");
  expect(first.origin).not.toBe(second.origin);
  expect(contexts.forRequest(request(first.documentUrl)).versionSeq).toBe(1);
  expect(contexts.forRequest(request(second.documentUrl)).versionSeq).toBe(2);
  expect(first.documentUrl.endsWith("/files/notes/a%20%23%20b%3F.md")).toBe(true);
  expect(() => contexts.forRequest(request(`${first.origin}:444/files/data.json`))).toThrow(
    "unavailable",
  );
  expect(() =>
    contexts.forRequest(request(first.documentUrl.replace("preview.example", "other.example"))),
  ).toThrow("unavailable");
  expect(() => contexts.forRequest(new Request(first.documentUrl))).toThrow("unavailable");
  expect(() => contexts.create(id, 1, "data.json", "https://app.example")).toThrow(
    "rendered document",
  );
  expect(() => previewDocumentUrl({ origin: first.origin }, "../data.json")).toThrow();
  time += 30 * 60 * 1000;
  const renewed = contexts.renew(first.id);
  expect(Date.parse(renewed.expiresAt)).toBe(time + 60 * 60 * 1000);
  time += 31 * 60 * 1000;
  expect(() => contexts.forRequest(request(second.documentUrl))).toThrow("expired");
  expect(contexts.forRequest(request(first.documentUrl)).versionSeq).toBe(1);
  contexts.revoke(first.id);
  expect(() => contexts.forRequest(request(first.documentUrl))).toThrow("unavailable");
});

test("preview policies scope resources, forbid forms/redirects/WebRTC, and delegate local capture", () => {
  const context = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  const scope = contexts.forRequest(request(context.documentUrl));
  const headers = previewPolicy(scope);
  const allowlist = headers.get("connection-allowlist")!;
  expect(allowlist).toBe(
    `("${scope.origin}/files/*" "${scope.origin}/r3/*"); webrtc=block; redirects=block`,
  );
  expect(headers.get("content-security-policy")).toContain("form-action 'none'");
  expect(headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-same-origin allow-forms",
  );
  expect(headers.get("permissions-policy")).toBe("camera=(self), microphone=(self)");
  expect(headers.has("set-cookie")).toBe(false);
  // Header assertions prove configuration only; browser acceptance must prove enforcement.
  contexts.revokeArtifact(id);
  expect(() => contexts.forRequest(request(context.documentUrl))).toThrow("unavailable");
});

test("preview origins require secure contexts and a separate hostname namespace", () => {
  expect(() => new PreviewContexts(storage.artifacts, "http://preview.example")).toThrow("HTTPS");
  expect(() => new PreviewContexts(storage.artifacts, "http://127.preview.example")).toThrow(
    "HTTPS",
  );
  expect(() => new PreviewContexts(storage.artifacts, "https://preview.example/base")).toThrow(
    "URL path",
  );
  expect(() => new PreviewContexts(storage.artifacts, "https://127.0.0.1")).toThrow("DNS hostname");
  const local = new PreviewContexts(storage.artifacts, "http://localhost:8792");
  const context = local.create(id, 1, "notes/a # b?.md", "http://localhost:8791");
  expect(new URL(context.origin).port).toBe("8792");
  expect(() => local.create(id, 1, "notes/a # b?.md", "http://127.0.0.1:8791")).not.toThrow();
  expect(() => local.create(id, 1, "notes/a # b?.md", "http://[::1]:8791")).not.toThrow();
  expect(() => local.create(id, 1, "notes/a # b?.md", context.origin)).toThrow("cannot host");
  const kept = contexts.create(id, 1, "notes/a # b?.md", "https://app.example");
  storage.artifacts.delete(id);
  expect(() => contexts.forRequest(request(kept.documentUrl))).toThrow();
});
