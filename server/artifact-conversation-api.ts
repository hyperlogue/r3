import type { Hono } from "hono";
import { buildArtifactPrompt, commentAttachments } from "../shared/artifact-prompt.ts";
import type {
  ArtifactCommentAcknowledged,
  ArtifactCommentRead,
  ArtifactCommentSnapshot,
  ArtifactDetail,
} from "../shared/artifacts.ts";
import { ATTACHMENT_LIMITS } from "../shared/attachments.ts";
import { type ArtifactAuthPolicy, artifactAuthenticated } from "./artifact-auth.ts";
import type { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { artifactEvents } from "./artifact-events.ts";
import { artifactJson, artifactJsonResponse } from "./artifact-http.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError, requireString } from "./artifact-validation.ts";

function ids(value: unknown, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw new ArtifactError("Expected between 1 and 1000 thread IDs");
  return [...new Set(value.map((id) => requireString(id, "Thread ID", 200)))];
}

export function installArtifactConversations(
  app: Hono,
  storage: ArtifactStorage,
  collaboration: ArtifactCollaboration,
  detailFor: (id: string) => ArtifactDetail,
  policy: ArtifactAuthPolicy,
) {
  const { artifacts, conversations } = storage;
  const shutdown = new AbortController();
  const changed = (artifactId: string, threadId: string | null) =>
    collaboration.broadcast(
      threadId
        ? { type: "threads-updated", artifactId, threadId }
        : { type: "artifact-updated", artifactId },
    );
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
  app.get("/api/artifacts/:id/threads", (c) =>
    artifactJsonResponse(c.req.raw, conversations.list(c.req.param("id"))),
  );
  app.post("/api/artifacts/:id/threads", async (c) => {
    const threads = await conversations.add(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(threads.artifactId, threads.id);
    return c.json(threads, 201);
  });
  app.get("/api/threads/:id", (c) => c.json(conversations.get(c.req.param("id"))));
  app.get("/api/threads/:id/source", async (c) =>
    artifactJsonResponse(c.req.raw, await conversations.source(c.req.param("id"))),
  );
  app.patch("/api/threads/:id", async (c) => {
    const threads = await conversations.update(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(threads.artifactId, threads.id);
    return c.json(threads);
  });
  app.delete("/api/threads/:id", async (c) => {
    const input = await artifactJson(c.req.raw);
    const threads = conversations.get(c.req.param("id"));
    conversations.delete(threads.id, input.actor);
    changed(threads.artifactId, threads.id);
    return c.json({ ok: true });
  });
  app.post("/api/threads/:id/comments", async (c) => {
    const comment = await conversations.addComment(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(comment.artifactId, comment.threadId);
    return c.json(comment, 201);
  });
  app.get("/api/comments/:id", (c) => c.json(conversations.comment(c.req.param("id"))));
  app.patch("/api/comments/:id", async (c) => {
    const comment = await conversations.updateComment(
      c.req.param("id"),
      await artifactJson(c.req.raw, ATTACHMENT_LIMITS.requestBytes),
    );
    changed(comment.artifactId, comment.threadId);
    return c.json(comment);
  });
  app.on(["POST", "DELETE"], "/api/claims", async (c) => {
    const input = await artifactJson(c.req.raw);
    const sessionId = requireString(input.sessionId, "Agent session ID", 200);
    const threadIds = ids(input.threadIds, true)!;
    const affected = new Set(threadIds.map((id) => conversations.get(id).artifactId));
    const result =
      c.req.method === "POST"
        ? conversations.claim(threadIds, sessionId)
        : conversations.release(threadIds, sessionId);
    for (const artifactId of affected)
      collaboration.broadcast({ type: "presence-changed", artifactId });
    return c.json(result ?? { ok: true });
  });

  app.get("/api/artifacts/:id/comments/pending", (c) => {
    const id = c.req.param("id");
    const snapshot = conversations.snapshot(id, ids(c.req.query("threads")?.split(",")));
    c.header("cache-control", "no-store");
    return c.json({
      text: buildArtifactPrompt(detailFor(id), snapshot.threads, true, snapshot.comments),
      itemCount: snapshot.threads.length + snapshot.comments.length,
      attachments: commentAttachments(snapshot.threads, true),
      acknowledgment: snapshot.acknowledgment,
    } satisfies ArtifactCommentSnapshot);
  });
  app.get("/api/artifacts/:id/comments/history", (c) => {
    const detail = detailFor(c.req.param("id"));
    const only = ids(c.req.query("threads")?.split(","));
    const selected = detail.threads.filter((threads) =>
      only ? only.includes(threads.id) : threads.status === "open",
    );
    return c.json({
      text: buildArtifactPrompt(
        detail,
        selected,
        false,
        only ? [] : conversations.artifactComments(detail.id),
      ),
      itemCount: selected.length + (only ? 0 : conversations.artifactComments(detail.id).length),
      attachments: commentAttachments(selected),
    } satisfies ArtifactCommentRead);
  });
  app.post("/api/artifacts/:id/comments/acknowledge", async (c) => {
    const id = c.req.param("id");
    const input = await artifactJson(c.req.raw);
    const expectedFingerprint = requireString(
      input.expectedFingerprint,
      "Expected comment fingerprint",
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw new ArtifactError("Invalid comment fingerprint");
    const artifactCommentCount = input.threads ? 0 : conversations.pendingComments(id).length;
    const selected = conversations.acknowledge(id, {
      threads: ids(input.threads),
      expectedFingerprint,
    });
    if (selected.length || artifactCommentCount)
      collaboration.broadcast({ type: "artifact-updated", artifactId: id });
    return c.json({
      acknowledgedCount: selected.length + artifactCommentCount,
    } satisfies ArtifactCommentAcknowledged);
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
  app.delete("/api/artifacts/:id/listen", async (c) => {
    const input = await artifactJson(c.req.raw);
    collaboration.unlisten(c.req.param("id"), artifacts.validateActor(input.actor));
    return c.json({ ok: true });
  });
  app.get("/api/events", (c) => {
    const id = c.req.query("artifact");
    if (id) artifacts.get(id);
    return artifactEvents(
      collaboration,
      AbortSignal.any([c.req.raw.signal, shutdown.signal]),
      () => artifactAuthenticated(c.req.raw, storage.authentication, policy, storage.clientAuth),
      id,
    );
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
    },
  };
}
