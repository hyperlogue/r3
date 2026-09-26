import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactActor, PublishArtifactBody } from "../shared/artifacts.ts";
import { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let collaboration: ArtifactCollaboration;
let id: string;
let sent: string[];
let fail = false;
const first = { role: "agent", sessionId: "publisher" } as const;
const second = { role: "agent", sessionId: "helper" } as const;
const generic = { role: "agent", sessionId: "generic" } as const;
const human = { role: "human", sessionId: null } as const;
const request = (
  actor: ArtifactActor,
  expectedSeq: number,
  key = String(expectedSeq),
): PublishArtifactBody => ({
  actor,
  expectedSeq,
  publicationKey: key,
  content: {
    kind: "files",
    files: [{ path: "note.txt", mediaType: "text/plain", base64: "SGVsbG8=" }],
  },
});

async function open() {
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  collaboration = new ArtifactCollaboration(
    storage.artifacts,
    storage.conversations,
    storage.lifecycle,
    undefined,
    storage.listeners,
    async (target) => {
      sent.push(target.harness === "codex" ? target.threadId : "claude");
      if (fail) throw new Error("Delivery unavailable");
      return "queued";
    },
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-durable-listeners-"));
  sent = [];
  fail = false;
  await open();
  for (const actor of [first, second, generic])
    storage.artifacts.registerSession({ id: actor.sessionId });
  storage.listeners.setTarget(first.sessionId, { harness: "codex", threadId: "first-thread" });
  storage.listeners.setTarget(second.sessionId, { harness: "codex", threadId: "second-thread" });
  id = storage.artifacts.create({ actor: first, kind: "files" }).id;
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});

test("fallback and explicit listener survive restart without submitting pending feedback", async () => {
  await storage.artifacts.publish(id, request(first, 0));
  await storage.conversations.add(id, {
    actor: human,
    body: "Unsubmitted note",
    target: { kind: "artifact" },
  });
  collaboration.listen(id, second);
  storage.close();
  await open();
  expect(sent).toEqual([]);
  expect(collaboration.watchers(id)[0]).toMatchObject({ mode: "explicit", actor: second });
  expect(JSON.stringify(collaboration.watchers(id))).not.toContain("second-thread");
  expect(await collaboration.submit(id)).toEqual({ state: "queued" });
  collaboration.unlisten(id, second);
  expect(collaboration.watchers(id)[0]).toMatchObject({ mode: "fallback", actor: first });
  expect(await collaboration.submit(id)).toEqual({ state: "queued" });
  expect(sent).toEqual(["second-thread", "first-thread"]);
  expect(storage.conversations.unsent(id)).toHaveLength(1);
});

test("failed fallback remains; failed explicit listener yields only on the next send", async () => {
  await storage.artifacts.publish(id, request(first, 0));
  fail = true;
  expect((await collaboration.submit(id)).state).toBe("failed");
  expect(collaboration.watchers(id)[0]?.actor).toEqual(first);
  collaboration.listen(id, second);
  expect((await collaboration.submit(id)).state).toBe("failed");
  expect(sent).toEqual(["first-thread", "second-thread"]);
  expect(collaboration.watchers(id)[0]?.actor).toEqual(first);
  storage.close();
  await open();
  expect(collaboration.watchers(id)[0]?.actor).toEqual(first);
  fail = false;
  await collaboration.submit(id);
  expect(sent.at(-1)).toBe("first-thread");
});

test("publication order controls fallback, while retries and explicit listeners cannot be displaced", async () => {
  const original = request(first, 0);
  await storage.artifacts.publish(id, original);
  await storage.artifacts.publish(id, request(second, 1));
  await storage.artifacts.publish(id, original);
  expect(collaboration.watchers(id)[0]?.actor).toEqual(second);
  collaboration.listen(id, first);
  await storage.artifacts.publish(id, request(generic, 2));
  expect(collaboration.watchers(id)[0]?.actor).toEqual(first);
  collaboration.unlisten(id, first);
  expect(collaboration.watchers(id)).toEqual([]);
  await storage.artifacts.publish(id, request(first, 3));
  expect(collaboration.watching(id)).toBe(true);
  await storage.artifacts.publish(id, { ...request(second, 4), listen: false });
  expect(collaboration.watchers(id)).toEqual([]);
});

test("archive removes both durable recipients; restore and old publication retries do not revive them", async () => {
  const original = request(first, 0);
  await storage.artifacts.publish(id, original);
  collaboration.listen(id, second);
  await collaboration.transition(id, {
    actor: human,
    event: "archived",
    operationKey: "archive",
    message: "Finished",
  });
  expect(sent).toEqual(["second-thread"]);
  storage.close();
  await open();
  await storage.artifacts.publish(id, original);
  expect(collaboration.watchers(id)).toEqual([]);
  await collaboration.transition(id, { actor: human, event: "restored", operationKey: "restore" });
  expect(collaboration.watchers(id)).toEqual([]);
  expect(sent).toEqual(["second-thread"]);
});

test("watch cancellation and daemon restart cannot leave a dead override ahead of fallback", async () => {
  await storage.artifacts.publish(id, request(first, 0));
  const controller = new AbortController();
  const waiting = collaboration.watch(id, generic, { signal: controller.signal });
  expect(collaboration.watchers(id)[0]?.kind).toBe("watch");
  controller.abort();
  expect(await waiting).toEqual({ result: "cancelled" });
  expect(collaboration.watchers(id)[0]?.actor).toEqual(first);
  storage.close();
  await open();
  expect(collaboration.watchers(id)[0]?.mode).toBe("fallback");
});

test("a stale failing send cannot remove a replacement explicit listener", async () => {
  await storage.artifacts.publish(id, request(first, 0));
  const delivery = Promise.withResolvers<"sent">();
  collaboration = new ArtifactCollaboration(
    storage.artifacts,
    storage.conversations,
    storage.lifecycle,
    undefined,
    storage.listeners,
    () => delivery.promise,
  );
  collaboration.listen(id, second);
  const sending = collaboration.submit(id);
  const replacement = collaboration.listen(id, first);
  delivery.reject(new Error("Old send failed"));
  expect((await sending).state).toBe("failed");
  expect(collaboration.watchers(id)[0]?.id).toBe(replacement.id);
});

test("schema 3 upgrades preserve artifacts and add durable local registrations", async () => {
  await storage.artifacts.publish(id, request(first, 0));
  storage.close();
  const old = new Database(join(root, "store.sqlite"));
  old.exec(
    "DROP TABLE artifact_listeners; DROP TABLE local_agent_targets; ALTER TABLE feedback DROP COLUMN ever_delivered; ALTER TABLE artifacts DROP COLUMN feedback_revision; PRAGMA user_version = 3",
  );
  old.close();
  await open();
  expect(storage.artifacts.versions(id)).toHaveLength(1);
  expect(storage.migration?.migrated).toBe(true);
  storage.listeners.setTarget(first.sessionId, { harness: "codex", threadId: "new-thread" });
  collaboration.listen(id, first);
  storage.close();
  await open();
  expect(collaboration.watchers(id)[0]?.actor).toEqual(first);
});
