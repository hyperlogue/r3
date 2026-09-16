import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ArtifactApiError } from "../../shared/artifact-client.ts";
import type { ArtifactPreviewContext, ArtifactPreviewNetwork } from "../../shared/artifacts.ts";
import { PreviewSessions } from "./preview-sessions.ts";

function fixture() {
  const contexts = new Map<string, ArtifactPreviewContext>();
  const bytes = new Map<string, string>();
  const storage = {
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => {
      bytes.set(key, value);
    },
  };
  let created = 0;
  let renewed = 0;
  const revoked: string[] = [];
  const api = {
    async createPreview(
      artifactId: string,
      versionSeq: number,
      path: string,
      network: ArtifactPreviewNetwork = "blocked",
    ) {
      created++;
      const id = `p${randomBytes(24).toString("hex")}`;
      const root = `https://preview.example/__r3_preview/${id}/`;
      const context: ArtifactPreviewContext = {
        id,
        artifactId,
        versionSeq,
        network,
        origin: "https://preview.example",
        resourceRoot: `${root}files/`,
        documentUrl: `${root}files/${path}`,
        gateUrl: `${root}r3/gate`,
        utilityUrl: `${root}r3/utility.js`,
        presentation: "document",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      contexts.set(id, context);
      return context;
    },
    async renewPreview(id: string) {
      renewed++;
      const context = contexts.get(id);
      if (!context) throw new ArtifactApiError(404, null, "Expired");
      return context;
    },
    async revokePreview(id: string) {
      revoked.push(id);
      contexts.delete(id);
    },
  };
  return { api, storage, contexts, revoked, counts: () => ({ created, renewed }) };
}

test("protected preview URLs survive view switches and refresh, with authenticated renewal", async () => {
  const f = fixture();
  const firstVisit = new PreviewSessions(f.api, () => f.storage);
  const [first, concurrent] = await Promise.all([
    firstVisit.acquire("artifact_example", 1, "index.md", "blocked"),
    firstVisit.acquire("artifact_example", 1, "index.md", "blocked"),
  ]);
  expect(first.id).toBe(concurrent.id);
  expect(f.counts().created).toBe(1);
  firstVisit.release(first);
  firstVisit.release(concurrent);
  expect(f.revoked).toHaveLength(0);
  const refreshed = new PreviewSessions(f.api, () => f.storage);
  const second = await refreshed.acquire("artifact_example", 1, "index.md", "blocked");
  expect(second.documentUrl).toBe(first.documentUrl);
  expect(f.counts()).toEqual({ created: 1, renewed: 1 });
  const otherVersion = await refreshed.acquire("artifact_example", 2, "index.md", "blocked");
  expect(otherVersion.id).not.toBe(first.id);
  refreshed.release(second);
  f.contexts.delete(first.id);
  expect((await refreshed.acquire("artifact_example", 1, "index.md", "blocked")).id).not.toBe(
    first.id,
  );
});

test("external grants never persist and a failed authentication never falls back to creation", async () => {
  const f = fixture();
  const sessions = new PreviewSessions(f.api, () => f.storage);
  const external = await sessions.acquire("artifact_example", 1, "index.html", "external");
  sessions.release(external);
  expect(f.revoked).toContain(external.id);
  const protectedContext = await sessions.acquire("artifact_example", 1, "index.html", "blocked");
  sessions.release(protectedContext);
  const created = f.counts().created;
  f.api.renewPreview = async () => {
    throw new ArtifactApiError(401, null, "Login required");
  };
  await expect(
    sessions.acquire("artifact_example", 1, "index.html", "blocked"),
  ).rejects.toMatchObject({ status: 401 });
  expect(f.counts().created).toBe(created);
});

test("retention is bounded without revoking mounted previews", async () => {
  const f = fixture();
  const sessions = new PreviewSessions(f.api, () => f.storage);
  const loaded = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      sessions.acquire("artifact_example", index + 1, "index.md", "blocked"),
    ),
  );
  expect(f.revoked).toHaveLength(0);
  for (const context of loaded) sessions.release(context);
  expect(f.contexts.size).toBe(16);
  sessions.forget("artifact_example");
  expect(f.contexts.size).toBe(0);
  const refreshed = new PreviewSessions(f.api, () => f.storage);
  expect((await refreshed.acquire("artifact_example", 20, "index.md", "blocked")).id).not.toBe(
    loaded[19].id,
  );
});

test("deletion cancels a pending acquisition even when storage is unavailable", async () => {
  const f = fixture();
  const context = await f.api.createPreview("artifact_example", 1, "index.md");
  let resolve!: (context: ArtifactPreviewContext) => void;
  f.api.createPreview = () =>
    new Promise((done) => {
      resolve = done;
    });
  const sessions = new PreviewSessions(f.api, () => {
    throw new Error("Storage unavailable");
  });
  const pending = sessions.acquire("artifact_example", 1, "index.md", "blocked");
  sessions.forget("artifact_example");
  resolve(context);
  await expect(pending).rejects.toThrow("no longer available");
  expect(f.revoked).toContain(context.id);
});
