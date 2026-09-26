import type { Hono } from "hono";
import { buildArtifactPrompt } from "../shared/artifact-prompt.ts";
import type {
  ArtifactDetail,
  ArtifactFeedbackAcknowledged,
  ArtifactFeedbackRead,
  ArtifactFeedbackSnapshot,
} from "../shared/artifacts.ts";
import { AgentConnections } from "./agent-connections.ts";
import type { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { ARTIFACT_EVENT_HEADERS, artifactEvents } from "./artifact-events.ts";
import { artifactJson, artifactJsonResponse } from "./artifact-http.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError, requireString } from "./artifact-validation.ts";

function ids(value: unknown, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw new ArtifactError("Expected between 1 and 1000 feedback IDs");
  return [...new Set(value.map((id) => requireString(id, "Feedback ID", 200)))];
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
  const changed = (artifactId: string, feedbackId: string) =>
    collaboration.broadcast({ type: "feedback-updated", artifactId, feedbackId });
  app.get("/api/artifacts/:id/feedback", (c) =>
    artifactJsonResponse(c.req.raw, conversations.list(c.req.param("id"))),
  );
  app.post("/api/artifacts/:id/feedback", async (c) => {
    const feedback = await conversations.add(c.req.param("id"), await artifactJson(c.req.raw));
    changed(feedback.artifactId, feedback.id);
    return c.json(feedback, 201);
  });
  app.get("/api/feedback/:id", (c) => c.json(conversations.get(c.req.param("id"))));
  app.patch("/api/feedback/:id", async (c) => {
    const feedback = conversations.edit(c.req.param("id"), await artifactJson(c.req.raw));
    changed(feedback.artifactId, feedback.id);
    return c.json(feedback);
  });
  app.delete("/api/feedback/:id", async (c) => {
    const input = await artifactJson(c.req.raw);
    const feedback = conversations.get(c.req.param("id"));
    conversations.delete(feedback.id, input.actor);
    changed(feedback.artifactId, feedback.id);
    return c.json({ ok: true });
  });
  app.post("/api/feedback/:id/replies", async (c) => {
    const reply = await conversations.addReply(c.req.param("id"), await artifactJson(c.req.raw));
    changed(reply.artifactId, reply.feedbackId);
    return c.json(reply, 201);
  });
  app.patch("/api/replies/:id", async (c) => {
    const reply = conversations.editReply(c.req.param("id"), await artifactJson(c.req.raw));
    changed(reply.artifactId, reply.feedbackId);
    return c.json(reply);
  });
  app.put("/api/feedback/:id/placements", async (c) => {
    const placement = await conversations.place(c.req.param("id"), await artifactJson(c.req.raw));
    changed(placement.artifactId, placement.feedbackId);
    return c.json(placement);
  });
  app.on(["POST", "DELETE"], "/api/claims", async (c) => {
    const input = await artifactJson(c.req.raw);
    const sessionId = requireString(input.sessionId, "Agent session ID", 200);
    const feedbackIds = ids(input.feedbackIds, true)!;
    const affected = new Set(feedbackIds.map((id) => conversations.get(id).artifactId));
    const result =
      c.req.method === "POST"
        ? conversations.claim(feedbackIds, sessionId)
        : conversations.release(feedbackIds, sessionId);
    for (const artifactId of affected)
      collaboration.broadcast({ type: "presence-changed", artifactId });
    return c.json(result ?? { ok: true });
  });

  app.get("/api/artifacts/:id/feedback/pending", (c) => {
    const id = c.req.param("id");
    const snapshot = conversations.snapshot(id, ids(c.req.query("feedback")?.split(",")));
    c.header("cache-control", "no-store");
    return c.json({
      text: buildArtifactPrompt(detailFor(id), snapshot.feedback, true),
      itemCount: snapshot.feedback.length,
      acknowledgment: snapshot.acknowledgment,
    } satisfies ArtifactFeedbackSnapshot);
  });
  app.get("/api/artifacts/:id/feedback/history", (c) => {
    const detail = detailFor(c.req.param("id"));
    const only = ids(c.req.query("feedback")?.split(","));
    const selected = detail.feedback.filter((feedback) =>
      only ? only.includes(feedback.id) : feedback.status === "open",
    );
    return c.json({
      text: buildArtifactPrompt(detail, selected),
      itemCount: selected.length,
    } satisfies ArtifactFeedbackRead);
  });
  app.post("/api/artifacts/:id/feedback/acknowledge", async (c) => {
    const id = c.req.param("id");
    const input = await artifactJson(c.req.raw);
    const expectedFingerprint = requireString(
      input.expectedFingerprint,
      "Expected feedback fingerprint",
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw new ArtifactError("Invalid feedback fingerprint");
    const selected = conversations.acknowledge(id, {
      feedback: ids(input.feedback),
      expectedFingerprint,
    });
    if (selected.length) collaboration.broadcast({ type: "artifact-updated", artifactId: id });
    return c.json({ acknowledgedCount: selected.length } satisfies ArtifactFeedbackAcknowledged);
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
    storage.authentication.expireSessions();
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
