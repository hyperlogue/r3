import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactActor, ArtifactNudge, ArtifactStreamEvent } from "../shared/artifacts.ts";
import { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let collaboration: ArtifactCollaboration;
let id: string;
const human: ArtifactActor = { role: "human", sessionId: null };
const first: ArtifactActor = { role: "agent", sessionId: "first-agent" };
const second: ArtifactActor = { role: "agent", sessionId: "second-agent" };
const archive = (key: string, message?: string) => ({
  actor: human,
  event: "archived",
  operationKey: key,
  ...(message === undefined ? {} : { message }),
});
const restore = (key: string) => ({ actor: human, event: "restored", operationKey: key });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-collaboration-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    isWatching: (id) => collaboration?.watching(id) ?? false,
  });
  collaboration = new ArtifactCollaboration(
    storage.artifacts,
    storage.conversations,
    storage.lifecycle,
  );
  storage.artifacts.registerSession({ id: first.sessionId });
  storage.artifacts.registerSession({ id: second.sessionId });
  id = storage.artifacts.create({ kind: "files", actor: human }).id;
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});

describe("artifact collaboration ordering", () => {
  test("archive with no message commits history and unregisters without a push", async () => {
    const pushes: ArtifactNudge[] = [];
    const closes: string[] = [];
    const events: ArtifactStreamEvent[] = [];
    collaboration.register(
      id,
      first,
      (reason) => closes.push(reason),
      async (nudge) => {
        pushes.push(nudge);
      },
    );
    collaboration.subscribe((event) => events.push(event));
    const result = await collaboration.transition(id, archive("quiet"));
    expect(result.notification).toEqual({ state: "none" });
    expect(pushes).toEqual([]);
    expect(closes).toEqual(["archived"]);
    expect(collaboration.watchers(id)).toEqual([]);
    expect(storage.artifacts.get(id).state).toBe("archived");
    expect(events.map((event) => event.type)).toEqual(["lifecycle", "presence-changed"]);
    expect(storage.lifecycle.events(id)).toEqual([result.event]);
  });

  test("archive pushes its captured listener after commit and retry leaves a restored listener alone", async () => {
    const pushes: ArtifactNudge[] = [];
    collaboration.register(
      id,
      first,
      () => {},
      async (nudge) => {
        expect(storage.artifacts.get(id).state).toBe("archived");
        expect(collaboration.watchers(id)).toEqual([]);
        expect(storage.lifecycle.events(id).at(-1)?.id).toBe(nudge.lifecycleEventId!);
        pushes.push(nudge);
      },
    );
    const request = archive("with-message", "Continue with the next iteration");
    const archived = await collaboration.transition(id, request);
    expect(archived.notification).toEqual({ state: "sent" });
    expect(pushes).toHaveLength(1);
    await collaboration.transition(id, restore("restore"));
    const current = collaboration.register(
      id,
      second,
      () => {},
      async () => {
        throw new Error("Must not receive an old event");
      },
    );
    expect((await collaboration.transition(id, request)).notification).toEqual({
      state: "not_repeated",
    });
    expect(collaboration.watchers(id)).toEqual([current]);
    expect(pushes[0].message).toBe("Continue with the next iteration");
  });

  test("failed delivery preserves committed archive history and cannot evict a newer registration", async () => {
    let rejectPush!: (error: Error) => void;
    collaboration.register(
      id,
      first,
      () => {},
      () =>
        new Promise((_, reject) => {
          rejectPush = reject;
        }),
    );
    const pending = collaboration.transition(id, archive("delayed", "Saved archive message"));
    expect(storage.artifacts.get(id).state).toBe("archived");
    await collaboration.transition(id, restore("restored-before-ack"));
    const current = collaboration.register(
      id,
      second,
      () => {},
      async () => {},
    );
    rejectPush(new Error("Harness delivery failed"));
    const result = await pending;
    expect(result.notification).toEqual({ state: "failed", error: "Harness delivery failed" });
    expect(storage.lifecycle.events(id)[0].message).toBe("Saved archive message");
    expect(collaboration.watchers(id)).toEqual([current]);
  });

  test("watch always ends on archive and terminal state precedes already pending feedback", async () => {
    const waiting = collaboration.watch(id, first);
    await collaboration.transition(id, archive("done", "Iteration complete"));
    expect(await waiting).toMatchObject({
      result: "archived",
      event: { message: "Iteration complete" },
    });
    await storage.conversations.add(id, {
      actor: human,
      target: { kind: "artifact" },
      body: "Still pending",
    });
    expect(await collaboration.watch(id, second)).toMatchObject({ result: "archived" });
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    await expect(collaboration.submit(id)).rejects.toMatchObject({ status: 409 });
  });

  test("ordinary watch wakes on explicit handoff without stamping delivery and refuses another owner", async () => {
    const waiting = collaboration.watch(id, first);
    await expect(collaboration.watch(id, second)).rejects.toMatchObject({ status: 409 });
    await storage.conversations.add(id, {
      actor: human,
      target: { kind: "artifact" },
      body: "Please revise",
    });
    expect(collaboration.watchers(id)).toHaveLength(1);
    expect(await collaboration.submit(id)).toEqual({ state: "sent" });
    expect(await waiting).toEqual({ result: "feedback" });
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    expect(collaboration.watchers(id)).toEqual([]);
  });

  test("watch cancellation, timeout and same-session replacement release only their own slot", async () => {
    expect(await collaboration.watch(id, first, { timeoutMs: 1 })).toEqual({ result: "timeout" });
    const controller = new AbortController();
    const cancelled = collaboration.watch(id, first, { signal: controller.signal });
    controller.abort();
    expect(await cancelled).toEqual({ result: "cancelled" });
    const old = collaboration.watch(id, first);
    const current = collaboration.register(
      id,
      first,
      () => {},
      async () => {},
    );
    expect(await old).toEqual({ result: "superseded" });
    expect(collaboration.watchers(id)).toEqual([current]);
  });
});
