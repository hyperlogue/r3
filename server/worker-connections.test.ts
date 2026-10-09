import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactClient } from "../shared/artifact-client.ts";
import type { ArtifactActor } from "../shared/artifacts.ts";
import { readEventStream } from "../shared/event-stream.ts";
import {
  WORKER_PROTOCOL,
  type WorkerEvent,
  type WorkerSubscription,
} from "../shared/worker-protocol.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string,
  storage: ArtifactStorage,
  api: ReturnType<typeof createArtifactApi>,
  client: ArtifactClient,
  id: string;
let token: string;
const publisher: ArtifactActor = { role: "agent", sessionId: "publisher" },
  helper: ArtifactActor = { role: "agent", sessionId: "helper" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-workers-"));
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  token = randomBytes(32).toString("base64url");
  api = createArtifactApi(storage, {
    token,
    requireLogin: true,
    version: "fixture",
    allowedHost: (host) => host === "r3.example",
    publicUrl: "https://review.example/workspace",
  });
  client = makeClient(token);
  for (const actor of [publisher, helper])
    storage.artifacts.registerSession({ id: actor.sessionId! });
  id = storage.artifacts.create({ kind: "files", actor: publisher }).id;
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
function makeClient(secret: string) {
  return new ArtifactClient({
    url: "https://r3.example",
    token: secret,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      headers.set("host", "r3.example");
      return Promise.resolve(api.app.fetch(new Request(request, { headers })));
    },
  });
}
async function connect(workerId = randomUUID(), via = client) {
  const response = await via.request("POST", "/api/workers/connect", {
    workerId,
    protocol: WORKER_PROTOCOL,
  });
  const events = readEventStream(response.body!);
  const ready = JSON.parse((await events.next()).value!.data) as Extract<
    WorkerEvent,
    { type: "ready" }
  >;
  expect(ready.type).toBe("ready");
  return { workerId, connectionId: ready.connectionId, events, client: via };
}
type Connection = Awaited<ReturnType<typeof connect>>;
async function target(connection: Connection, actor: ArtifactActor) {
  const listenerId = randomUUID();
  await connection.client.json("POST", `/api/workers/${connection.connectionId}/targets`, {
    actor,
    listenerId,
  });
  return listenerId;
}
async function event(connection: Connection, type: WorkerEvent["type"]): Promise<WorkerEvent> {
  for (;;) {
    const next = await connection.events.next();
    if (next.done) throw new Error("Stream ended");
    const value = JSON.parse(next.value.data) as WorkerEvent;
    if (value.type === type) return value;
  }
}
async function publish(actor = publisher, expected = 0, key = randomUUID()) {
  return client.json<{ url: string; listener?: WorkerSubscription; seq: number }>(
    "POST",
    `/api/artifacts/${id}/versions`,
    {
      actor,
      expectedSeq: expected,
      publicationKey: key,
      content: {
        kind: "files",
        files: [
          {
            path: "note.txt",
            mediaType: "text/plain",
            base64: Buffer.from("Review").toString("base64"),
          },
        ],
      },
    },
  );
}
async function listen(connection: Connection, actor: ArtifactActor, listenerId: string) {
  const subscription: WorkerSubscription = {
    id: randomUUID(),
    artifactId: id,
    actor,
    mode: "explicit",
    listenerId,
  };
  await connection.client.json(
    "POST",
    `/api/workers/${connection.connectionId}/listen`,
    subscription,
  );
  return subscription;
}
async function send(connection: Connection, ok: boolean) {
  const result = client
    .json<{ notification: { state: string } }>("POST", `/api/artifacts/${id}/submit`)
    .catch((error) => error.result);
  const nudge = (await event(connection, "nudge")) as Extract<WorkerEvent, { type: "nudge" }>;
  await connection.client.json("POST", `/api/workers/${connection.connectionId}/acknowledgments`, {
    nudgeId: nudge.nudge.id,
    ok,
    state: "queued",
  });
  return { result: await result, nudge };
}
test("opaque IDs preserve fallback selection and failed explicit sends never resend", async () => {
  const connection = await connect();
  const fallback = await target(connection, publisher),
    explicit = await target(connection, helper);
  const publication = await publish();
  expect(publication.url).toBe(`https://review.example/workspace/${id}`);
  await listen(connection, helper, explicit);
  expect(api.collaboration.watchers(id)[0].actor).toEqual(helper);
  const failed = await send(connection, false);
  expect(failed.nudge.listenerId).toBe(explicit);
  expect(failed.result.notification.state).toBe("failed");
  expect(api.collaboration.watchers(id)[0].actor).toEqual(publisher);
  const resumed = await send(connection, true);
  expect(resumed.nudge.listenerId).toBe(fallback);
  expect(resumed.result.notification.state).toBe("queued");
  await send(connection, false);
  expect(api.collaboration.watchers(id)[0].actor).toEqual(publisher);
});
test("publication updates the fallback under a watch; ending the watch selects it", async () => {
  const connection = await connect();
  await target(connection, publisher);
  await target(connection, helper);
  const key = randomUUID();
  await publish(publisher, 0, key);
  const watchAbort = new AbortController();
  const watching = api.collaboration.watch(id, helper, { signal: watchAbort.signal });
  await publish(helper, 1);
  await publish(publisher, 0, key);
  expect(api.collaboration.watchers(id)[0].kind).toBe("watch");
  watchAbort.abort();
  await watching;
  expect(api.collaboration.watchers(id)[0].actor).toEqual(helper);
});
test("disconnect removes both roles; reconnect restores both atomically and preserves any incumbent", async () => {
  const first = await connect();
  await target(first, publisher);
  const explicit = await target(first, helper);
  const fallback = (await publish()).listener!;
  const listening = await listen(first, helper, explicit);
  await first.events.return(undefined);
  expect(api.collaboration.watchers(id)).toEqual([]);
  const next = await connect(first.workerId);
  for (const subscription of [fallback, listening])
    await client.json("POST", `/api/workers/${next.connectionId}/targets`, {
      actor: subscription.actor,
      listenerId: subscription.listenerId,
    });
  await client.json("POST", `/api/workers/${next.connectionId}/resume`, {
    subscriptions: [fallback, listening],
  });
  expect(api.collaboration.registration(id, "fallback")?.actor).toEqual(publisher);
  expect(api.collaboration.watchers(id)[0].actor).toEqual(helper);
  await next.events.return(undefined);
  const other = await connect();
  await target(other, publisher);
  await publish(publisher, 1);
  const reconnect = await connect(first.workerId);
  await client.json("POST", `/api/workers/${reconnect.connectionId}/targets`, {
    actor: helper,
    listenerId: listening.listenerId,
  });
  await expect(
    client.json("POST", `/api/workers/${reconnect.connectionId}/resume`, {
      subscriptions: [listening],
    }),
  ).rejects.toThrow("already has a recipient");
  expect(api.collaboration.watchers(id)[0].actor).toEqual(publisher);
});
test("unlisten and archive retire subscriptions so lost retirement events cannot revive them", async () => {
  const connection = await connect();
  await target(connection, publisher);
  const explicit = await target(connection, helper);
  const fallback = (await publish()).listener!,
    listening = await listen(connection, helper, explicit);
  await client.json("DELETE", `/api/artifacts/${id}/listen`, { actor: helper });
  expect(storage.workerRecords.get(listening.id)?.state).toBe("retired");
  await client.json("POST", `/api/artifacts/${id}/lifecycle`, {
    actor: { role: "human", sessionId: null },
    event: "archived",
    operationKey: randomUUID(),
  });
  expect(storage.workerRecords.get(fallback.id)?.state).toBe("retired");
  await client.json("POST", `/api/artifacts/${id}/lifecycle`, {
    actor: { role: "human", sessionId: null },
    event: "restored",
    operationKey: randomUUID(),
  });
  await expect(
    client.json("POST", `/api/workers/${connection.connectionId}/resume`, {
      subscriptions: [fallback, listening],
    }),
  ).rejects.toThrow("no longer eligible");
});
test("client revocation closes only its connections and cannot remove another client's fallback", async () => {
  const firstKey = storage.clientAuth.createKey(null),
    secondKey = storage.clientAuth.createKey(null);
  const first = await connect(randomUUID(), makeClient(firstKey.token));
  await target(first, publisher);
  await publish();
  const second = await connect(randomUUID(), makeClient(secondKey.token));
  const explicit = await target(second, helper);
  await listen(second, helper, explicit);
  storage.clientAuth.revoke(secondKey.id);
  expect(api.collaboration.watchers(id)[0].actor).toEqual(publisher);
  expect(((await event(second, "closed")) as { reason: string }).reason).toBe(
    "authorization-revoked",
  );
  await expect(
    first.client.json("POST", `/api/workers/${second.connectionId}/targets`, {
      actor: publisher,
      listenerId: randomUUID(),
    }),
  ).rejects.toThrow();
});

test("local migration adopts both saved roles once and preserves browser access and artifact bytes", async () => {
  storage.listeners.setTarget(publisher.sessionId!, {
    harness: "codex",
    threadId: "fixture-publisher",
  });
  storage.listeners.setTarget(helper.sessionId!, { harness: "codex", threadId: "fixture-helper" });
  await storage.artifacts.publish(id, {
    actor: publisher,
    expectedSeq: 0,
    publicationKey: randomUUID(),
    content: {
      kind: "files",
      files: [
        {
          path: "note.txt",
          mediaType: "text/plain",
          base64: Buffer.from("Retained").toString("base64"),
        },
      ],
    },
  });
  storage.listeners.register(id, helper, "explicit");
  const login = storage.authentication.createLoginToken(null);
  const legacy = storage.listeners.exportLocal();
  expect(legacy).toHaveLength(2);
  const connection = await connect();
  const subscriptions: WorkerSubscription[] = [];
  for (const { target: _target, ...subscription } of legacy)
    subscriptions.push({
      ...subscription,
      listenerId: await target(connection, subscription.actor),
    });
  await client.json("POST", `/api/workers/${connection.connectionId}/resume`, { subscriptions });
  expect(storage.listeners.exportLocal()).toEqual([]);
  expect(api.collaboration.registration(id, "fallback")?.actor).toEqual(publisher);
  expect(api.collaboration.watchers(id)[0].actor).toEqual(helper);
  expect(storage.authentication.verifyLogin(login.token)).not.toBeNull();
  expect(
    await (
      await client.request("GET", `/api/artifacts/${id}/versions/1/resource?path=note.txt`)
    ).text(),
  ).toBe("Retained");
});

test("archive and replacement retire offline intent even if no worker receives the event", async () => {
  const original = await connect();
  await target(original, publisher);
  const saved = (await publish()).listener!;
  await original.events.return(undefined);
  await client.json("POST", `/api/artifacts/${id}/lifecycle`, {
    actor: { role: "human", sessionId: null },
    event: "archived",
    operationKey: randomUUID(),
  });
  await client.json("POST", `/api/artifacts/${id}/lifecycle`, {
    actor: { role: "human", sessionId: null },
    event: "restored",
    operationKey: randomUUID(),
  });
  const resumed = await connect(original.workerId);
  await client.json("POST", `/api/workers/${resumed.connectionId}/targets`, {
    actor: publisher,
    listenerId: saved.listenerId,
  });
  await expect(
    client.json("POST", `/api/workers/${resumed.connectionId}/resume`, { subscriptions: [saved] }),
  ).rejects.toThrow("no longer eligible");
  const replacement = (await publish(publisher, 1)).listener!;
  await resumed.events.return(undefined);
  const newer = await connect();
  await target(newer, helper);
  await publish(helper, 2);
  await newer.events.return(undefined);
  expect(api.collaboration.watchers(id)).toEqual([]);
  expect(storage.workerRecords.get(replacement.id)?.state).toBe("retired");
});
