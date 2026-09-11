import { Hono } from "hono";
import type { ArtifactDetail, ArtifactKind, ArtifactState } from "../shared/artifacts.ts";
import { type ArtifactAuthPolicy, installArtifactAuth } from "./artifact-auth.ts";
import { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { artifactJson, artifactJsonResponse } from "./artifact-http.ts";
import { artifactResourceResponse } from "./artifact-resources.ts";
import { artifactSource } from "./artifact-source.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError, requireArtifactPath, requireSequence } from "./artifact-validation.ts";
import { listThemes, themeStyle } from "./highlight.ts";
import { renderStoredPatch, storedPatchContext } from "./patch-content.ts";

export function artifactDetail(storage: ArtifactStorage, id: string): ArtifactDetail {
  return {
    ...storage.artifacts.get(id),
    versions: storage.artifacts.versions(id),
    feedback: storage.conversations.list(id),
    placements: storage.conversations.placements(id),
    events: storage.lifecycle.events(id),
  };
}

export function artifactSequence(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new ArtifactError("Invalid version sequence");
  return requireSequence(Number(value));
}

// No import opens a store, resolves a repo, or discovers a daemon. The same API
// serves a local daemon and a remote publisher against injected storage.
export function createArtifactApi(storage: ArtifactStorage, policy: ArtifactAuthPolicy) {
  const app = new Hono();
  const { artifacts } = storage;
  const collaboration = new ArtifactCollaboration(
    artifacts,
    storage.conversations,
    storage.lifecycle,
  );
  app.onError((error, c) =>
    error instanceof ArtifactError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "Artifact request failed" }, 500),
  );
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  installArtifactAuth(app, storage.authentication, policy);

  app.get("/api/sessions", (c) => c.json(artifacts.sessions()));
  app.post("/api/sessions", async (c) =>
    c.json(artifacts.registerSession(await artifactJson(c.req.raw))),
  );
  app.get("/api/projects", (c) => c.json(artifacts.projects()));
  app.post("/api/projects", async (c) =>
    c.json(artifacts.createProject(await artifactJson(c.req.raw)), 201),
  );
  app.delete("/api/projects/:id", (c) => {
    artifacts.deleteProject(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/themes", (c) => c.json(listThemes()));
  app.get("/api/theme-style", async (c) => c.json(await themeStyle(c.req.query("theme"))));

  app.get("/api/artifacts", (c) => {
    const state = c.req.query("state");
    const kind = c.req.query("kind");
    if (state !== undefined && state !== "active" && state !== "archived")
      throw new ArtifactError("Invalid artifact state");
    if (kind !== undefined && !["files", "html", "diff"].includes(kind))
      throw new ArtifactError("Invalid artifact kind");
    const meta: Record<string, string> = {};
    for (const [key, value] of new URL(c.req.url).searchParams)
      if (key.startsWith("meta."))
        Object.defineProperty(meta, key.slice(5), { value, enumerable: true, configurable: true });
    return artifactJsonResponse(
      c.req.raw,
      artifacts
        .list({
          state: state as ArtifactState | undefined,
          kind: kind as ArtifactKind | undefined,
          projectId: c.req.query("project"),
          meta,
        })
        .map((artifact) => ({ ...artifact, watching: collaboration.watching(artifact.id) })),
    );
  });
  app.post("/api/artifacts", async (c) => {
    const artifact = artifacts.create(await artifactJson(c.req.raw));
    collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
    return c.json(artifact, 201);
  });
  app.get("/api/artifacts/:id", (c) => {
    const detail = artifactDetail(storage, c.req.param("id"));
    detail.watching = collaboration.watching(detail.id);
    return artifactJsonResponse(c.req.raw, detail);
  });
  app.patch("/api/artifacts/:id", async (c) => {
    const artifact = artifacts.edit(c.req.param("id"), await artifactJson(c.req.raw));
    collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
    return c.json(artifact);
  });
  app.delete("/api/artifacts/:id", async (c) => {
    const id = c.req.param("id");
    artifacts.delete(id);
    collaboration.deleted(id);
    await storage.collectBlobs();
    return c.json({ ok: true });
  });
  app.get("/api/artifacts/:id/versions", (c) => c.json(artifacts.versions(c.req.param("id"))));
  app.post("/api/artifacts/:id/versions", async (c) => {
    // Base64, JSON escaping of paths/patches, and metadata fit above the stricter
    // decoded publication limits. Server maxRequestBodySize must match this cap.
    const version = await artifacts.publish(
      c.req.param("id"),
      await artifactJson(c.req.raw, 200 * 1024 * 1024),
    );
    collaboration.broadcast({
      type: "version-published",
      artifactId: version.artifactId,
      seq: version.seq,
    });
    return c.json(version, 201);
  });
  app.get("/api/artifacts/:id/versions/:seq", (c) =>
    c.json(artifacts.version(c.req.param("id"), artifactSequence(c.req.param("seq")))),
  );
  app.get("/api/artifacts/:id/versions/:seq/files", (c) =>
    c.json(artifacts.files(c.req.param("id"), artifactSequence(c.req.param("seq")))),
  );
  app.get("/api/artifacts/:id/versions/:seq/source", async (c) =>
    artifactJsonResponse(
      c.req.raw,
      await artifactSource(
        artifacts,
        c.req.param("id"),
        artifactSequence(c.req.param("seq")),
        requireArtifactPath(c.req.query("path")),
        c.req.query("theme"),
      ),
    ),
  );
  app.get("/api/artifacts/:id/versions/:seq/resource", (c) =>
    artifactResourceResponse(
      artifacts,
      c.req.raw,
      c.req.param("id"),
      artifactSequence(c.req.param("seq")),
      requireArtifactPath(c.req.query("path")),
    ),
  );
  app.get("/api/artifacts/:id/versions/:seq/diff", async (c) =>
    artifactJsonResponse(
      c.req.raw,
      await renderStoredPatch(
        artifacts.patch(c.req.param("id"), artifactSequence(c.req.param("seq"))),
        c.req.query("theme"),
      ),
    ),
  );
  app.get("/api/artifacts/:id/versions/:seq/diff-context", async (c) => {
    const path = requireArtifactPath(c.req.query("path"));
    const lines = await storedPatchContext(
      artifacts.patch(c.req.param("id"), artifactSequence(c.req.param("seq"))),
      path,
      artifactSequence(c.req.query("start")),
      artifactSequence(c.req.query("end")),
      c.req.query("theme"),
    );
    if (!lines) throw new ArtifactError("Captured context not found", 404);
    return artifactJsonResponse(c.req.raw, { path, lines });
  });
  app.get("/api/artifacts/:id/versions/:seq/patch", (c) => {
    c.header("Content-Disposition", 'attachment; filename="publication.patch"');
    c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    return c.text(artifacts.patch(c.req.param("id"), artifactSequence(c.req.param("seq"))));
  });
  app.get("/api/artifacts/:id/viewed", (c) => c.json(artifacts.viewed(c.req.param("id"))));
  app.put("/api/artifacts/:id/viewed", async (c) => {
    artifacts.setViewed(c.req.param("id"), await artifactJson(c.req.raw));
    return c.json({ ok: true });
  });
  return { app, collaboration };
}
