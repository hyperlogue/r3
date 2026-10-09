import type { Hono } from "hono";
import { buildArtifactPrompt, discussionAttachments } from "../shared/artifact-prompt.ts";
import type {
  ArtifactDetail,
  ArtifactDiscussionAcknowledged,
  ArtifactDiscussionRead,
  ArtifactDiscussionSnapshot,
} from "../shared/artifacts.ts";
import { ATTACHMENT_LIMITS } from "../shared/attachments.ts";
import { AgentConnections } from "./agent-connections.ts";
import type { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { ARTIFACT_EVENT_HEADERS, artifactEvents } from "./artifact-events.ts";
import { artifactJson, artifactJsonResponse } from "./artifact-http.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError, requireString } from "./artifact-validation.ts";

function ids(value: unknown, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw new ArtifactError("Expected between 1 and 1000 discussions IDs");
  return [...new Set(value.map((id) => requireString(id, "Discussion ID", 200)))];
}

export function installArtifactConversations(
  app: Hono,
  storage: ArtifactStorage,
  collaboration: ArtifactCollaboration,
  detailFor: (id: string) => ArtifactDetail,
) {
  const { artifacts, conversations } = storage;
  const agents = new AgentConnections(collaboration);
  const shutdown = new AbortController();
  const changed = (artifactId: string, discussionId: string) =>
    collaboration.broadcast({ type: "discussions-updated", artifactId, discussionId });
  app.on(["GET", "HEAD"], "/api/artifacts/:id/attachments/:image", async (c) => {
    const { attachment, bytes } = await artifacts.attachments.read(
      c.req.param("id"),
      c.req.param("image"),
    );
    return new Response(c.req.method === "HEAD" ? null : new Uint8Array(bytes), {
      headers: {
        "Content-Type": attachment.mediaType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "Content-Disposition": `inline; filename="${attachment.id}.${attachment.mediaType === "image/png" ? "png" : "jpg"}"`,
      },
    });
  });
  app.get("/api/artifacts/:id/discussions", (c) =>
    artifactJsonResponse(c.req.raw, conversations.list(c.req.param("id"))),
  );
  app.post("/api/artifacts/:id/discussions", async (c) => {
    const discussions = await conversations.add(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(discussions.artifactId, discussions.id);
    return c.json(discussions, 201);
  });
  app.get("/api/discussions/:id", (c) => c.json(conversations.get(c.req.param("id"))));
  app.get("/api/discussions/:id/source", async (c) =>
    artifactJsonResponse(c.req.raw, await conversations.source(c.req.param("id"))),
  );
  app.patch("/api/discussions/:id", async (c) => {
    const discussions = await conversations.update(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(discussions.artifactId, discussions.id);
    return c.json(discussions);
  });
  app.delete("/api/discussions/:id", async (c) => {
    const input = await artifactJson(c.req.raw);
    const discussions = conversations.get(c.req.param("id"));
    conversations.delete(discussions.id, input.actor);
    changed(discussions.artifactId, discussions.id);
    return c.json({ ok: true });
  });
  app.post("/api/discussions/:id/comments", async (c) => {
    const comment = await conversations.addComment(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(comment.artifactId, comment.discussionId);
    return c.json(comment, 201);
  });
  app.patch("/api/comments/:id", async (c) => {
    const comment = await conversations.updateComment(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(comment.artifactId, comment.discussionId);
    return c.json(comment);
  });
  app.put("/api/discussions/:id/placements", async (c) => {
    const placement = await conversations.place(c.req.param("id"), await artifactJson(c.req.raw));
    changed(placement.artifactId, placement.discussionId);
    return c.json(placement);
  });
  app.on(["POST", "DELETE"], "/api/claims", async (c) => {
    const input = await artifactJson(c.req.raw);
    const sessionId = requireString(input.sessionId, "Agent session ID", 200);
    const discussionIds = ids(input.discussionIds, true)!;
    const affected = new Set(discussionIds.map((id) => conversations.get(id).artifactId));
    const result =
      c.req.method === "POST"
        ? conversations.claim(discussionIds, sessionId)
        : conversations.release(discussionIds, sessionId);
    for (const artifactId of affected)
      collaboration.broadcast({ type: "presence-changed", artifactId });
    return c.json(result ?? { ok: true });
  });

  app.get("/api/artifacts/:id/discussions/pending", (c) => {
    const id = c.req.param("id");
    const snapshot = conversations.snapshot(id, ids(c.req.query("discussions")?.split(",")));
    c.header("cache-control", "no-store");
    return c.json({
      text: buildArtifactPrompt(detailFor(id), snapshot.discussions, true),
      itemCount: snapshot.discussions.length,
      attachments: discussionAttachments(snapshot.discussions, true),
      acknowledgment: snapshot.acknowledgment,
    } satisfies ArtifactDiscussionSnapshot);
  });
  app.get("/api/artifacts/:id/discussions/history", (c) => {
    const detail = detailFor(c.req.param("id"));
    const only = ids(c.req.query("discussions")?.split(","));
    const selected = detail.discussions.filter((discussions) =>
      only ? only.includes(discussions.id) : discussions.status === "open",
    );
    return c.json({
      text: buildArtifactPrompt(detail, selected),
      itemCount: selected.length,
      attachments: discussionAttachments(selected),
    } satisfies ArtifactDiscussionRead);
  });
  app.post("/api/artifacts/:id/discussions/acknowledge", async (c) => {
    const id = c.req.param("id");
    const input = await artifactJson(c.req.raw);
    const expectedFingerprint = requireString(
      input.expectedFingerprint,
      "Expected discussions fingerprint",
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw new ArtifactError("Invalid discussions fingerprint");
    const selected = conversations.acknowledge(id, {
      discussions: ids(input.discussions),
      expectedFingerprint,
    });
    if (selected.length) collaboration.broadcast({ type: "artifact-updated", artifactId: id });
    return c.json({ acknowledgedCount: selected.length } satisfies ArtifactDiscussionAcknowledged);
  });
  app.post("/api/artifacts/:id/submit", async (c) => {
    const notification = await collaboration.submit(c.req.param("id"));
    return c.json({ notification }, notification.state === "failed" ? 502 : 200);
  });
  app.post("/api/artifacts/:id/lifecycle", async (c) => {
    const result = await collaboration.transition(c.req.param("id"), await artifactJson(c.req.raw));
    return c.json(result, result.notification.state === "failed" ? 502 : 200);
  });
  app.get("/api/artifacts/:id/watchers", (c) => c.json(collaboration.watchers(c.req.param("id"))));
  app.post("/api/artifacts/:id/watch", async (c) => {
    const input = await artifactJson(c.req.raw);
    if (input.timeoutMs !== undefined && typeof input.timeoutMs !== "number")
      throw new ArtifactError("Invalid watch timeout");
    const result = await collaboration.watch(
      c.req.param("id"),
      artifacts.validateActor(input.actor),
      {
        signal: AbortSignal.any([c.req.raw.signal, shutdown.signal]),
        timeoutMs: input.timeoutMs,
      },
    );
    return c.json(result);
  });
  app.post("/api/artifacts/:id/listen", async (c) => {
    const input = await artifactJson(c.req.raw);
    const connection = agents.open(c.req.param("id"), artifacts.validateActor(input.actor));
    return new Response(connection.stream, { headers: ARTIFACT_EVENT_HEADERS });
  });
  app.delete("/api/artifacts/:id/listen", async (c) => {
    const input = await artifactJson(c.req.raw);
    collaboration.unlisten(c.req.param("id"), artifacts.validateActor(input.actor));
    return c.json({ ok: true });
  });
  app.post("/api/connections/:id/acknowledgments", async (c) => {
    agents.acknowledge(c.req.param("id"), await artifactJson(c.req.raw));
    return c.json({ ok: true });
  });
  app.get("/api/events", (c) => {
    const id = c.req.query("artifact");
    if (id) artifacts.get(id);
    return artifactEvents(collaboration, AbortSignal.any([c.req.raw.signal, shutdown.signal]), id);
  });
  const expiry = setInterval(() => {
    for (const artifactId of conversations.expireClaims())
      collaboration.broadcast({ type: "presence-changed", artifactId });
    try {
      storage.authentication.flushLastUsed();
    } catch {
      console.error("r3: authentication housekeeping failed");
    }
  }, 60_000);
  expiry.unref();
  return {
    close() {
      clearInterval(expiry);
      shutdown.abort();
      agents.close();
    },
  };
}
