import { Hono } from "hono";
import { parse as parseCookie } from "hono/utils/cookie";
import {
  type ArtifactDetail,
  type ArtifactKind,
  type ArtifactState,
  artifactAgentIds,
} from "../shared/artifacts.ts";
import { PREVIEW_RESUME_COOKIE, previewResumeKeys } from "../shared/preview-resume.ts";
import type { ApplicationBootstrap } from "../shared/types.ts";
import type { WorkerSubscription } from "../shared/worker-protocol.ts";
import {
  type ArtifactAuthPolicy,
  artifactBoot,
  artifactRequestHostname,
  artifactSameOrigin,
  installArtifactAuth,
} from "./artifact-auth.ts";
import { ArtifactCollaboration, type LocalAgentDelivery } from "./artifact-collaboration.ts";
import { installArtifactConversations } from "./artifact-conversation-api.ts";
import { artifactJson, artifactJsonResponse } from "./artifact-http.ts";
import { artifactResourceResponse } from "./artifact-resources.ts";
import { parseArtifactSearch } from "./artifact-search.ts";
import { artifactSourceResponse } from "./artifact-source.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactUpdates } from "./artifact-updates.ts";
import { ArtifactError, requireArtifactPath, requireSequence } from "./artifact-validation.ts";
import { COOKIE_NAME } from "./auth.ts";
import { listThemes, themeStyle } from "./highlight.ts";
import { renderStoredPatch, storedPatchContext } from "./patch-content.ts";
import type { PreviewHost } from "./preview-host.ts";
import { WorkerConnections } from "./worker-connections.ts";

export function artifactDetail(storage: ArtifactStorage, id: string): ArtifactDetail {
  const detail: ArtifactDetail = {
    ...storage.artifacts.get(id),
    versions: storage.artifacts.versions(id),
    discussions: storage.conversations.list(id),
    placements: storage.conversations.placements(id),
    events: storage.lifecycle.events(id),
  };
  detail.agentLabels = storage.artifacts.sessionLabels(artifactAgentIds(detail));
  return detail;
}

export function artifactSequence(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new ArtifactError("Invalid version sequence");
  return requireSequence(Number(value));
}

// No import opens a store, resolves a repo, or discovers a daemon. The same API
// serves a local daemon and a remote publisher against injected storage.
export function createArtifactApi(
  storage: ArtifactStorage,
  policy: ArtifactAuthPolicy,
  options: { previews?: PreviewHost; deliver?: LocalAgentDelivery } = {},
) {
  const app = new Hono();
  const { artifacts } = storage;
  const collaboration = new ArtifactCollaboration(
    artifacts,
    storage.conversations,
    storage.lifecycle,
    undefined,
    storage.listeners,
    options.deliver,
    storage.workerRecords,
  );
  const workers = new WorkerConnections(storage, collaboration, policy);
  const detail = (id: string): ArtifactDetail => ({
    ...artifactDetail(storage, id),
    watching: collaboration.watching(id),
  });
  const updates = new ArtifactUpdates(storage, collaboration, detail);
  const bootstrap = (request: Request): ApplicationBootstrap | null => {
    const host = artifactRequestHostname(request);
    if (host === null || !policy.allowedHost(host) || !artifactSameOrigin(request, policy))
      return null;
    const cookie = parseCookie(request.headers.get("cookie") ?? "", COOKIE_NAME)[COOKIE_NAME];
    const boot = artifactBoot(storage.authentication, policy, cookie);
    // Missing Strict cookies on cross-site entry need the same-origin /api/boot
    // fallback after navigation. Never embed private data in that generic shell.
    if (boot.needsAuth) return null;
    const path = new URL(request.url).pathname;
    const id = /^\/((?:artifact|review)_[\w]+)\/?$/.exec(path)?.[1];
    let artifact: ArtifactDetail | null = null;
    if (id) {
      try {
        artifact = updates.snapshot(id);
      } catch (error) {
        if (!(error instanceof ArtifactError) || error.status !== 404) throw error;
      }
    }
    let manifest: ApplicationBootstrap["manifest"] = null;
    let preview: ApplicationBootstrap["preview"] = null;
    if (artifact?.kind === "html") {
      const selected = new URL(request.url).searchParams.get("version");
      const seq =
        selected && /^[1-9]\d*$/.test(selected) && Number.isSafeInteger(Number(selected))
          ? Number(selected)
          : null;
      const version =
        seq === null ? artifact.versions.at(-1) : artifact.versions.find((v) => v.seq === seq);
      // Bound the extra shell payload. Larger manifests keep the existing
      // parallel API path; unknown explicit versions must never seed latest.
      if (version?.kind === "html" && version.fileCount <= 128) {
        const files = artifacts.files(artifact.id, version.seq);
        if (Buffer.byteLength(JSON.stringify(files)) <= 64 * 1024)
          manifest = { versionSeq: version.seq, files };
      }
      if (version?.kind === "html" && options.previews && request.method === "GET") {
        // Navigation has no Origin header. A configured public origin also
        // covers a proxy that rewrites Host; the browser accepts this seed only
        // when that application origin matches its own location.
        const origin =
          request.headers.get("origin") ??
          (policy.applicationOrigins?.size === 1
            ? [...policy.applicationOrigins][0]
            : new URL(request.url).origin);
        try {
          const keys = previewResumeKeys(
            parseCookie(request.headers.get("cookie") ?? "")[PREVIEW_RESUME_COOKIE],
          );
          const contexts = options.previews.contexts.resume(
            keys,
            artifact.id,
            version.seq,
            version.entrypoint,
            origin,
          );
          if (contexts.length) preview = { applicationOrigin: origin, contexts, retained: true };
          else {
            const prepared = options.previews.contexts.prepare(
              artifact.id,
              version.seq,
              version.entrypoint,
              origin,
            );
            preview = {
              applicationOrigin: origin,
              contexts: [prepared.blocked, prepared.compatible],
              retained: false,
            };
          }
        } catch (error) {
          // Optional setup must not make the workspace unavailable. The normal
          // API path reports configuration/capacity errors or renews a saved ID.
          if (!(error instanceof ArtifactError)) throw error;
        }
      }
    }
    return { path, boot, artifact, manifest, preview };
  };
  app.onError((error, c) =>
    error instanceof ArtifactError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "Artifact request failed" }, 500),
  );
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  installArtifactAuth(app, storage.authentication, policy, storage.clientAuth);
  workers.install(app);

  app.get("/api/stat", (c) => {
    const window = c.req.query("window") ?? "daily";
    if (window !== "daily" && window !== "weekly")
      throw new ArtifactError("window must be daily or weekly");
    c.header("Cache-Control", "no-store");
    return c.json(storage.usage.stat(window));
  });
  app.post("/api/gc", async (c) => {
    const result = storage.usage.gc(await artifactJson(c.req.raw));
    for (const id of result.deletedIds) {
      options.previews?.revokeArtifact(id);
      collaboration.deleted(id);
    }
    if (!result.dryRun) {
      try {
        await storage.collectBlobs();
      } catch {
        result.cleanupError =
          "Artifacts were removed, but blob cleanup failed; run gc again to retry cleanup";
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });

  app.get("/api/sessions", (c) => artifactJsonResponse(c.req.raw, artifacts.sessions()));
  app.post("/api/sessions", async (c) =>
    c.json(artifacts.registerSession(await artifactJson(c.req.raw))),
  );
  app.get("/api/projects", (c) => c.json(artifacts.projects()));
  app.post("/api/projects", async (c) =>
    c.json(artifacts.createProject(await artifactJson(c.req.raw)), 201),
  );
  app.patch("/api/projects/:id", async (c) => {
    const project = artifacts.editProject(c.req.param("id"), await artifactJson(c.req.raw));
    for (const artifact of artifacts.list({ projectId: project.id }))
      collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
    return c.json(project);
  });
  app.delete("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    const affected = artifacts.list({ projectId: id });
    artifacts.deleteProject(id);
    for (const artifact of affected)
      collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
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
  app.get("/api/search", async (c) => {
    const results = await storage.search.search(
      parseArtifactSearch(new URL(c.req.url).searchParams),
    );
    return artifactJsonResponse(c.req.raw, {
      ...results,
      artifacts: results.artifacts.map((artifact) => ({
        ...artifact,
        watching: collaboration.watching(artifact.id),
      })),
    });
  });
  app.post("/api/artifacts", async (c) => {
    const artifact = artifacts.create(await artifactJson(c.req.raw));
    collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
    return c.json(artifact, 201);
  });
  app.get("/api/artifacts/:id", (c) => {
    const id = c.req.param("id");
    return artifactJsonResponse(
      c.req.raw,
      c.req.query("view") === "summary"
        ? { ...artifacts.get(id), watching: collaboration.watching(id) }
        : updates.read(id, c.req.query("since")),
    );
  });
  app.patch("/api/artifacts/:id", async (c) => {
    const artifact = artifacts.edit(c.req.param("id"), await artifactJson(c.req.raw));
    collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
    return c.json(artifact);
  });
  app.delete("/api/artifacts/:id", async (c) => {
    const id = c.req.param("id");
    artifacts.delete(id);
    options.previews?.revokeArtifact(id);
    collaboration.deleted(id);
    await storage.collectBlobs();
    return c.json({ ok: true });
  });
  app.get("/api/artifacts/:id/versions", (c) => c.json(artifacts.versions(c.req.param("id"))));
  app.post("/api/artifacts/:id/versions", async (c) => {
    let listener: WorkerSubscription | undefined;
    // Base64, JSON escaping of paths/patches, and metadata fit above the stricter
    // decoded publication limits. Server maxRequestBodySize must match this cap.
    const version = await artifacts.publish(
      c.req.param("id"),
      await artifactJson(c.req.raw, 200 * 1024 * 1024),
      (actor, enabled) => {
        listener = workers.published(c.req.param("id"), actor, enabled);
      },
    );
    collaboration.broadcast({
      type: "version-published",
      artifactId: version.artifactId,
      seq: version.seq,
    });
    return c.json(
      {
        ...version,
        url: `${policy.publicUrl ?? new URL(c.req.url).origin}/${encodeURIComponent(version.artifactId)}`,
        listenerRegistered: !!collaboration.registration(version.artifactId, "fallback"),
        ...(listener ? { listener } : {}),
      },
      201,
    );
  });
  app.get("/api/artifacts/:id/versions/:seq", (c) =>
    c.json(artifacts.version(c.req.param("id"), artifactSequence(c.req.param("seq")))),
  );
  app.get("/api/artifacts/:id/versions/:seq/files", (c) =>
    c.json(artifacts.files(c.req.param("id"), artifactSequence(c.req.param("seq")))),
  );
  app.post("/api/artifacts/:id/versions/:seq/previews", async (c) => {
    if (!options.previews)
      return c.json({ error: "Rendered previews are not configured on this server" }, 503);
    const input = await artifactJson(c.req.raw, 4096);
    // Authentication has already checked the full Origin, including proxy
    // allowlisting. Never accept a parent origin from the JSON request body.
    const origin = c.req.header("origin") ?? new URL(c.req.url).origin;
    return c.json(
      options.previews.create(
        c.req.param("id"),
        artifactSequence(c.req.param("seq")),
        requireArtifactPath(input.path),
        origin,
        input.network,
      ),
      201,
    );
  });
  app.patch("/api/previews/:id", (c) => {
    if (!options.previews)
      return c.json({ error: "Rendered previews are not configured on this server" }, 503);
    return c.json(options.previews.renew(c.req.param("id")));
  });
  app.delete("/api/previews/:id", (c) => {
    options.previews?.revoke(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/artifacts/:id/versions/:seq/source", async (c) =>
    artifactSourceResponse(
      artifacts,
      c.req.raw,
      c.req.param("id"),
      artifactSequence(c.req.param("seq")),
      requireArtifactPath(c.req.query("path")),
      c.req.query("theme"),
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
  const conversations = installArtifactConversations(app, storage, collaboration, detail);
  return {
    app,
    bootstrap,
    collaboration,
    workers,
    close() {
      workers.close();
      conversations.close();
      updates.close();
    },
  };
}
