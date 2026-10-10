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
  ...(message === undefined ? {} : { comment: { body: message } }),
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
  test("long archive comments use bounded notifications without claiming complete delivery", async () => {
    const pushes: ArtifactNudge[] = [];
    collaboration.register(
      id,
      first,
      () => {},
      async (nudge) => {
        pushes.push(nudge);
      },
    );
    const body = "Archive detail ".repeat(1000);
    const result = await collaboration.transition(id, archive("long-comment", body));
    expect(result.notification.state).toBe("sent");
    expect(pushes[0]!.comment).toMatchObject({ id: result.event.comment!.id, truncated: true });
    expect(pushes[0]!.comment!.body).toHaveLength(8000);
    expect(storage.conversations.comment(result.event.comment!.id).body).toBe(body.trim());
    expect(result.event.comment!.sentAt).toBeNull();
    await collaboration.transition(id, restore("long-comment-restore"));
    expect(storage.conversations.snapshot(id).comments[0]!.body).toBe(body.trim());
  });
  test("archive comments remain editable after restore without rewriting lifecycle retries", async () => {
    let accept!: () => void;
    collaboration.register(
      id,
      first,
      () => {},
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const request = archive("comment-race", "Original archive comment");
    const pending = collaboration.transition(id, request);
    const event = storage.lifecycle.events(id)[0]!;
    const comment = event.comment!;
    expect(comment.threadId).toBeNull();
    expect(storage.conversations.comment(comment.id)).toEqual(comment);
    await expect(
      storage.conversations.updateComment(comment.id, { actor: human, body: "Too late" }),
    ).rejects.toMatchObject({ status: 409 });
    await collaboration.transition(id, restore("edit-after-restore"));
    await storage.conversations.updateComment(comment.id, { actor: human, body: "Changed" });
    await storage.conversations.updateComment(comment.id, { actor: human, body: comment.body });
    accept();
    expect((await pending).notification.state).toBe("sent");
    expect(storage.conversations.comment(comment.id).sentAt).toBeNull();
    const snapshot = storage.conversations.snapshot(id);
    expect(snapshot.comments.map((item) => item.id)).toEqual([comment.id]);
    await storage.conversations.updateComment(comment.id, { actor: human, body: "Final note" });
    expect(() => storage.conversations.acknowledge(id, snapshot.acknowledgment)).toThrow("changed");
    const retried = await collaboration.transition(id, request);
    expect(retried.notification.state).toBe("not_repeated");
    expect(retried.event.id).toBe(event.id);
    expect(retried.event.comment?.body).toBe("Final note");
    expect(storage.conversations.artifactComments(id)).toHaveLength(1);
    storage.conversations.acknowledge(id, storage.conversations.snapshot(id).acknowledgment);
    expect(storage.conversations.pendingComments(id)).toHaveLength(0);
  });
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
    expect(pushes[0].comment?.body).toBe("Continue with the next iteration");
  });

  test("failed delivery preserves committed archive history and cannot evict a newer registration", async () => {
    let rejectPush!: (error: Error) => void;
    collaboration.register(
      id,
      first,
      () => {},
      () =>
        new Promise<void>((_, reject) => {
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
    expect(storage.lifecycle.events(id)[0].comment?.body).toBe("Saved archive message");
    expect(collaboration.watchers(id)).toEqual([current]);
  });

  test("watch always ends on archive and terminal state precedes already pending comments", async () => {
    const waiting = collaboration.watch(id, first);
    await storage.conversations.add(id, {
      actor: human,
      target: { kind: "artifact" },
      body: "Still pending",
    });
    await collaboration.transition(id, archive("done", "Iteration complete"));
    expect(await waiting).toMatchObject({
      result: "archived",
      event: { comment: { body: "Iteration complete" } },
    });
    expect(await collaboration.watch(id, second)).toMatchObject({ result: "archived" });
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    await expect(collaboration.submit(id)).rejects.toMatchObject({ status: 409 });
  });

  test("explicit watch takes over and wakes on handoff without stamping delivery", async () => {
    const previous = collaboration.watch(id, first);
    const waiting = collaboration.watch(id, second);
    expect(await previous).toEqual({ result: "superseded" });
    await storage.conversations.add(id, {
      actor: human,
      target: { kind: "artifact" },
      body: "Please revise",
    });
    expect(collaboration.watchers(id)).toHaveLength(1);
    expect(await collaboration.submit(id)).toEqual({ state: "sent" });
    expect(await waiting).toEqual({ result: "comments" });
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
