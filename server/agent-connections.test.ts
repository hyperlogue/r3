import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactAgentStreamEvent } from "../shared/artifacts.ts";
import { AgentConnections } from "./agent-connections.ts";
import { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let collaboration: ArtifactCollaboration;
let connections: AgentConnections;
let id: string;
const actor = { role: "agent" as const, sessionId: "connected-agent" };
const human = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-agent-connection-"));
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  collaboration = new ArtifactCollaboration(
    storage.artifacts,
    storage.conversations,
    storage.lifecycle,
  );
  connections = new AgentConnections(collaboration, 100);
  storage.artifacts.registerSession({ id: actor.sessionId });
  id = storage.artifacts.create({ kind: "files", actor: human }).id;
});
afterEach(async () => {
  connections.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
async function next(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ArtifactAgentStreamEvent> {
  const chunk = await reader.read();
  if (chunk.done) throw new Error("Agent stream ended unexpectedly");
  const data = new TextDecoder()
    .decode(chunk.value)
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return JSON.parse(data!.slice(6));
}

describe("outward agent connections", () => {
  test("archive retains the captured connection through local delivery acknowledgment, then closes it", async () => {
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    expect(await next(reader)).toMatchObject({
      type: "ready",
      registration: { actor, kind: "listen" },
    });
    const pending = collaboration.transition(id, {
      actor: human,
      event: "archived",
      operationKey: "archive",
      message: "Saved message",
    });
    const frame = await next(reader);
    if (frame.type !== "nudge") throw new Error("Missing archive nudge");
    expect(frame.nudge).toMatchObject({ event: "archived", message: "Saved message" });
    expect(collaboration.watchers(id)).toEqual([]);
    connections.acknowledge(registration.id, { actor, nudgeId: frame.nudge.id, ok: true });
    expect((await pending).notification).toEqual({ state: "sent" });
    expect(await next(reader)).toEqual({ type: "closed", reason: "archived" });
    expect((await reader.read()).done).toBe(true);
  });

  test("a local harness rejection drops presence and cannot be acknowledged by another actor", async () => {
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const pending = collaboration.submit(id);
    const frame = await next(reader);
    if (frame.type !== "nudge") throw new Error("Missing submit nudge");
    expect(() =>
      connections.acknowledge(registration.id, { actor: human, nudgeId: frame.nudge.id, ok: true }),
    ).toThrow("connected agent session");
    connections.acknowledge(registration.id, {
      actor,
      nudgeId: frame.nudge.id,
      ok: false,
      error: "Harness is unavailable",
    });
    expect(await pending).toEqual({ state: "failed", error: "Harness is unavailable" });
    expect(collaboration.watchers(id)).toEqual([]);
    expect(await next(reader)).toEqual({ type: "closed", reason: "disconnected" });
  });

  test("timeout reports failed delivery and a same-agent reconnect supersedes only its old stream", async () => {
    connections.close();
    connections = new AgentConnections(collaboration, 5);
    const old = connections.open(id, actor);
    const oldReader = old.stream.getReader();
    await next(oldReader);
    const current = connections.open(id, actor);
    expect(await next(oldReader)).toEqual({ type: "closed", reason: "superseded" });
    await oldReader.cancel();
    expect(collaboration.watchers(id)).toEqual([current.registration]);
    expect(await collaboration.submit(id)).toMatchObject({
      state: "failed",
      error: "Agent delivery acknowledgment timed out",
    });
    expect(collaboration.watchers(id)).toEqual([]);
  });

  test("pending owner feedback is announced on connection without being marked delivered", async () => {
    await storage.conversations.add(id, {
      actor: human,
      body: "Please review",
      target: { kind: "artifact" },
    });
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const frame = await next(reader);
    if (frame.type !== "nudge") throw new Error("Missing pending feedback nudge");
    expect(frame.nudge.event).toBe("submitted");
    connections.acknowledge(registration.id, { actor, nudgeId: frame.nudge.id, ok: true });
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    await reader.cancel();
    expect(collaboration.watchers(id)).toEqual([]);
  });
});
