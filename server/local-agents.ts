import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Hono } from "hono";
import type { ArtifactCollaboration, LocalAgentDelivery } from "./artifact-collaboration.ts";
import { artifactJson } from "./artifact-http.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError, requireString } from "./artifact-validation.ts";
import { parseListenerTarget, pushToListener } from "./listener.ts";

export const deliverLocalAgent: LocalAgentDelivery = async (target, text) => {
  try {
    await pushToListener(target, text);
    return target.harness === "codex" ? "queued" : "sent";
  } catch {
    // Raw process/socket failures can contain credentials or local paths.
    throw new Error(
      target.harness === "codex"
        ? "Codex could not queue the notification. Check that Codex is available, then retry."
        : "Claude Code could not receive the notification. Resume the session and register it again.",
    );
  }
};

// This handler is served exclusively on the existing daemon's private Unix
// socket. Harness credentials never enter the application HTTP interface.
export function localAgentApi(
  storage: ArtifactStorage,
  collaboration: ArtifactCollaboration,
  token: string,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const supplied = Buffer.from(c.req.header("x-r3-token") ?? "");
    const expected = Buffer.from(token);
    if (
      c.req.header("origin") !== undefined ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return c.json({ error: "Forbidden" }, 403);
    await next();
  });
  app.onError((error, c) =>
    error instanceof ArtifactError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "Local agent registration failed" }, 500),
  );
  app.post("/api/local/target", async (c) => {
    const input = await artifactJson(c.req.raw);
    const actor = storage.artifacts.validateActor(input.actor);
    if (actor.role !== "agent") throw new ArtifactError("Listeners require an agent session");
    const parsed = parseListenerTarget(input.target);
    if (!parsed.ok) throw new ArtifactError(parsed.error);
    storage.listeners.setTarget(actor.sessionId, parsed.target);
    return c.json({ ok: true });
  });
  app.post("/api/local/listen", async (c) => {
    const input = await artifactJson(c.req.raw);
    return c.json(
      collaboration.listen(
        requireString(input.artifactId, "Artifact id", 200),
        storage.artifacts.validateActor(input.actor),
      ),
    );
  });
  return app;
}

export async function startLocalAgents(
  socket: string,
  storage: ArtifactStorage,
  collaboration: ArtifactCollaboration,
  token: string,
) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(socket));
  if (!parent.isDirectory() || (process.getuid && parent.uid !== process.getuid()))
    throw new Error("Local agent socket needs a private owned directory");
  await chmod(dirname(socket), 0o700);
  const previous = await lstat(socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous) {
    if (!previous.isSocket() || (process.getuid && previous.uid !== process.getuid()))
      throw new Error("Refusing to replace an unexpected local agent socket");
    await unlink(socket);
  }
  const app = localAgentApi(storage, collaboration, token);
  const server = Bun.serve({
    unix: socket,
    fetch: app.fetch,
    maxRequestBodySize: 32 * 1024,
    development: false,
  });
  try {
    await chmod(socket, 0o600);
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  return {
    async stop() {
      await server.stop(true);
    },
  };
}
