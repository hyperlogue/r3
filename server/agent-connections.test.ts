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
  test("each serialized notification gets its delivery deadline after dispatch", async () => {
    connections.close();
    connections = new AgentConnections(collaboration, 200);
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const first = collaboration.submit(id);
    const second = collaboration.submit(id);
    for (let index = 0; index < 2; index++) {
      const frame = await next(reader);
      if (frame.type !== "nudge") throw new Error("Missing submit nudge");
      await Bun.sleep(120);
      connections.acknowledge(registration.id, {
        actor,
        nudgeId: frame.nudge.id,
        ok: true,
        state: "queued",
      });
    }
    expect(await Promise.all([first, second])).toEqual([{ state: "queued" }, { state: "queued" }]);
    expect(collaboration.watchers(id)).toEqual([registration]);
    await reader.cancel();
  });

  test("archive waits behind an active notification and closes only after its own acknowledgment", async () => {
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const submitted = collaboration.submit(id);
    const first = await next(reader);
    if (first.type !== "nudge") throw new Error("Missing submit nudge");
    const archived = collaboration.transition(id, {
      actor: human,
      event: "archived",
      operationKey: "ordered-archive",
      message: "Saved after the current notification",
    });
    const following = next(reader);
    expect(
      await Promise.race([following.then(() => "frame"), Bun.sleep(10).then(() => "quiet")]),
    ).toBe("quiet");
    expect(storage.artifacts.get(id).state).toBe("archived");
    expect(collaboration.watchers(id)).toEqual([]);
    connections.acknowledge(registration.id, { actor, nudgeId: first.nudge.id, ok: true });
    expect(await submitted).toEqual({ state: "sent" });
    const last = await following;
    if (last.type !== "nudge") throw new Error("Missing archive nudge");
    expect(last.nudge.event).toBe("archived");
    connections.acknowledge(registration.id, {
      actor,
      nudgeId: last.nudge.id,
      ok: true,
      state: "queued",
    });
    expect((await archived).notification).toEqual({ state: "queued" });
    expect(await next(reader)).toEqual({ type: "closed", reason: "archived" });
    expect((await reader.read()).done).toBe(true);
  });

  test.each([
    "timeout",
    "rejection",
  ] as const)("%s of an active delivery closes the captured stream and rejects its queued archive", async (failure) => {
    connections.close();
    connections = new AgentConnections(collaboration, 20);
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const submitted = collaboration.submit(id);
    const first = await next(reader);
    if (first.type !== "nudge") throw new Error("Missing submit nudge");
    const archived = collaboration.transition(id, {
      actor: human,
      event: "archived",
      operationKey: `archive-after-${failure}`,
      message: "Retain this even if delivery fails",
    });
    if (failure === "rejection")
      connections.acknowledge(registration.id, {
        actor,
        nudgeId: first.nudge.id,
        ok: false,
        error: "Harness is unavailable",
      });
    expect(await submitted).toEqual({
      state: "failed",
      error:
        failure === "timeout"
          ? "Agent delivery acknowledgment timed out"
          : "Harness is unavailable",
    });
    expect((await archived).notification).toEqual({
      state: "failed",
      error: "Agent connection closed before delivery acknowledgment",
    });
    expect(await next(reader)).toEqual({ type: "closed", reason: "disconnected" });
    expect((await reader.read()).done).toBe(true);
    expect(collaboration.watchers(id)).toEqual([]);
    expect(storage.lifecycle.events(id)[0].message).toBe("Retain this even if delivery fails");
    expect(() =>
      connections.acknowledge(registration.id, { actor, nudgeId: first.nudge.id, ok: true }),
    ).toThrow("Agent connection not found");
  });

  test.each([
    "cancel",
    "shutdown",
  ] as const)("%s rejects active and queued deliveries without leaving presence", async (action) => {
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const deliveries = [collaboration.submit(id), collaboration.submit(id)];
    const first = await next(reader);
    if (first.type !== "nudge") throw new Error("Missing submit nudge");
    if (action === "cancel") await reader.cancel();
    else connections.close();
    expect(await Promise.all(deliveries)).toEqual([
      { state: "failed", error: "Agent connection closed before delivery acknowledgment" },
      { state: "failed", error: "Agent connection closed before delivery acknowledgment" },
    ]);
    expect(collaboration.watchers(id)).toEqual([]);
    expect(() =>
      connections.acknowledge(registration.id, { actor, nudgeId: first.nudge.id, ok: true }),
    ).toThrow("Agent connection not found");
    if (action === "shutdown")
      expect(await next(reader)).toEqual({ type: "closed", reason: "disconnected" });
    expect((await reader.read()).done).toBe(true);
  });

  test("supersession rejects the old queue and leaves the replacement deliverable", async () => {
    const old = connections.open(id, actor);
    const oldReader = old.stream.getReader();
    await next(oldReader);
    const deliveries = [collaboration.submit(id), collaboration.submit(id)];
    expect((await next(oldReader)).type).toBe("nudge");
    const current = connections.open(id, actor);
    const currentReader = current.stream.getReader();
    await next(currentReader);
    expect(await next(oldReader)).toEqual({ type: "closed", reason: "superseded" });
    expect((await oldReader.read()).done).toBe(true);
    expect((await Promise.all(deliveries)).every((result) => result.state === "failed")).toBe(true);
    expect(collaboration.watchers(id)).toEqual([current.registration]);
    const submitted = collaboration.submit(id);
    const frame = await next(currentReader);
    if (frame.type !== "nudge") throw new Error("Missing replacement nudge");
    connections.acknowledge(current.registration.id, { actor, nudgeId: frame.nudge.id, ok: true });
    expect(await submitted).toEqual({ state: "sent" });
    await currentReader.cancel();
  });

  test("the seventh pending notification retains the capacity failure and closes the bounded queue", async () => {
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const deliveries = Array.from({ length: 6 }, () => collaboration.submit(id));
    expect((await next(reader)).type).toBe("nudge");
    expect(collaboration.watchers(id)).toEqual([registration]);
    expect(await collaboration.submit(id)).toEqual({
      state: "failed",
      error: "Agent has too many unacknowledged notifications",
    });
    expect((await Promise.all(deliveries)).every((result) => result.state === "failed")).toBe(true);
    expect(await next(reader)).toEqual({ type: "closed", reason: "disconnected" });
    expect((await reader.read()).done).toBe(true);
    expect(collaboration.watchers(id)).toEqual([]);
  });

  test("a queued acknowledgment preserves delivery state and invalid states leave it pending", async () => {
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const pending = collaboration.submit(id);
    const frame = await next(reader);
    if (frame.type !== "nudge") throw new Error("Missing submit nudge");
    try {
      expect(() =>
        connections.acknowledge(registration.id, {
          actor,
          nudgeId: frame.nudge.id,
          ok: true,
          state: "failed",
        }),
      ).toThrow("Invalid delivery state");
      connections.acknowledge(registration.id, {
        actor,
        nudgeId: frame.nudge.id,
        ok: true,
        state: "queued",
      });
      expect(await pending).toEqual({ state: "queued" });
      expect(collaboration.watchers(id)).toEqual([registration]);
    } finally {
      await reader.cancel();
      await pending;
    }
  });

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

  test("registration leaves pending discussions alone until explicit submission", async () => {
    await storage.conversations.add(id, {
      actor: human,
      body: "Please review",
      target: { kind: "artifact" },
    });
    const { stream, registration } = connections.open(id, actor);
    const reader = stream.getReader();
    await next(reader);
    const noNudge = reader.read();
    expect(
      await Promise.race([noNudge.then(() => "frame"), Bun.sleep(10).then(() => "quiet")]),
    ).toBe("quiet");
    const submitted = collaboration.submit(id);
    const chunk = await noNudge;
    const frame = JSON.parse(
      new TextDecoder().decode(chunk.value).split("data: ")[1]!,
    ) as ArtifactAgentStreamEvent;
    if (frame.type !== "nudge") throw new Error("Missing pending discussions nudge");
    expect(frame.nudge.event).toBe("submitted");
    connections.acknowledge(registration.id, { actor, nudgeId: frame.nudge.id, ok: true });
    expect(await submitted).toEqual({ state: "sent" });
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    await reader.cancel();
    expect(collaboration.watchers(id)).toEqual([]);
  });
});
