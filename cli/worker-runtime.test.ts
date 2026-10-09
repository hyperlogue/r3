import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerSubscription } from "../shared/worker-protocol.ts";
import { BackendCredentials } from "./backend.ts";
import { WorkerProtocolFixture } from "./worker-protocol-fixture.ts";
import { WorkerRuntime } from "./worker-runtime.ts";

let root: string,
  credentials: BackendCredentials,
  fixture: WorkerProtocolFixture,
  worker: WorkerRuntime;
let delivered: string[];
const one = "https://one.example",
  two = "https://two.example";
const actor = { role: "agent", sessionId: "test-session" } as const;
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Worker did not reach expected state");
    await Bun.sleep(10);
  }
}
function runtime() {
  return new WorkerRuntime(
    join(root, "worker-state.json"),
    credentials,
    async (_target, text) => {
      delivered.push(text);
      return "queued";
    },
    fixture.fetch,
  );
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-worker-runtime-"));
  credentials = new BackendCredentials(join(root, "credentials"));
  fixture = new WorkerProtocolFixture();
  delivered = [];
  for (const url of [one, two]) {
    const accessToken = randomBytes(32).toString("hex");
    await credentials.save({ url, kind: "key", accessToken });
    fixture.add(url, accessToken);
  }
  worker = runtime();
});
afterEach(async () => {
  await worker.stop();
  await rm(root, { recursive: true, force: true });
});
async function subscribe(url: string) {
  const target = await worker.target(url, actor, { harness: "codex", threadId: "fixture-thread" });
  const subscription: WorkerSubscription = {
    id: randomUUID(),
    artifactId: randomUUID(),
    actor,
    listenerId: target.listenerId,
    mode: "explicit",
  };
  fixture.send(url, { type: "registered", subscription, registration: { id: subscription.id } });
  await until(() =>
    worker
      .status()
      .subscriptions.some(
        (value) => value.artifactId === subscription.artifactId && value.status === "active",
      ),
  );
  return subscription;
}
function nudge(subscription: WorkerSubscription, listenerId = subscription.listenerId) {
  return {
    type: "nudge",
    registrationId: subscription.id,
    listenerId,
    nudge: {
      id: randomUUID(),
      artifactId: subscription.artifactId,
      title: "Review",
      event: "submitted",
      lifecycleEventId: null,
      message: null,
    },
  };
}
test("an independent backend can deliver through an opaque ID; unknown and cross-backend IDs fail", async () => {
  const first = await subscribe(one),
    second = await subscribe(two);
  fixture.send(one, nudge(first));
  await until(() => fixture.backends.get(one)!.acknowledgments.length === 1);
  expect(delivered).toHaveLength(1);
  expect(fixture.backends.get(one)!.acknowledgments[0]).toMatchObject({
    ok: true,
    state: "queued",
  });
  fixture.send(two, nudge(second, first.listenerId));
  fixture.send(one, nudge(first, randomUUID()));
  await until(
    () =>
      fixture.backends.get(one)!.acknowledgments.length === 2 &&
      fixture.backends.get(two)!.acknowledgments.length === 1,
  );
  expect(delivered).toHaveLength(1);
  expect(fixture.backends.get(two)!.acknowledgments[0].ok).toBe(false);
});
test("worker restart reconnects without saving or restoring subscription intent", async () => {
  const subscription = await subscribe(one);
  const saved = await Bun.file(join(root, "worker-state.json")).json();
  expect(saved.version).toBe(2);
  expect(saved.subscriptions).toBeUndefined();
  await worker.stop();
  worker = runtime();
  worker.start();
  await until(() =>
    worker.status().subscriptions.some((value) => value.artifactId === subscription.artifactId),
  );
  fixture.send(one, nudge(subscription));
  await until(() => delivered.length === 1);
  fixture.disconnect(one);
  await until(
    () => fixture.backends.get(one)!.connects >= 3 && worker.status().backends[0].state === "ready",
  );
  expect(fixture.backends.get(one)!.requests.some((path) => path.endsWith("/resume"))).toBe(false);
});
test("credential rejection affects one backend and login reload recovers it without restarting the worker", async () => {
  await subscribe(one);
  await subscribe(two);
  fixture.backends.get(one)!.token = randomBytes(32).toString("hex");
  fixture.disconnect(one);
  await until(() =>
    worker.status().backends.some((value) => value.url === one && value.state === "login-required"),
  );
  expect(worker.status().backends.find((value) => value.url === two)?.state).toBe("ready");
  const workerId = worker.status().workerId;
  await credentials.save({ url: one, kind: "key", accessToken: fixture.backends.get(one)!.token });
  await worker.reload(one);
  await until(() => worker.status().backends.find((value) => value.url === one)?.state === "ready");
  expect(worker.status().workerId).toBe(workerId);
});

test("a waiting CLI survives the first connection failure", async () => {
  await worker.stop();
  let attempts = 0;
  worker = new WorkerRuntime(
    join(root, "worker-state.json"),
    credentials,
    async () => "queued",
    (request) => {
      if (request.url.endsWith("/connect") && ++attempts === 1)
        return Promise.resolve(new Response(null, { status: 503 }));
      return fixture.fetch(request);
    },
  );
  const result = await worker.target(one, actor, { harness: "codex", threadId: "fixture-thread" });
  expect(result.connectionId).toBeDefined();
  expect(attempts).toBe(2);
});
test("a running worker imports local destinations without recreating old subscriptions", async () => {
  const { writePrivateJson } = await import("./private-state.ts");
  const id = randomUUID(),
    artifactId = randomUUID();
  const imported = {
    url: one,
    listeners: [
      {
        id,
        artifactId,
        actor,
        mode: "fallback",
        target: { harness: "codex", threadId: "fixture-thread" },
      },
    ],
  };
  writePrivateJson(join(root, "worker-import.json"), imported);
  expect(worker.importLocal()).toBe(one);
  worker.start();
  await until(() => worker.status().backends[0]?.state === "ready");
  writePrivateJson(join(root, "worker-import.json"), imported);
  expect(worker.importLocal()).toBe(one);
  expect(worker.status().subscriptions).toHaveLength(0);
  expect(worker.importLocal()).toBeNull();
});

test("stopping the worker cancels stalled setup requests on a backend", async () => {
  await subscribe(one);
  await worker.stop();
  let stalled = false;
  worker = new WorkerRuntime(
    join(root, "worker-state.json"),
    credentials,
    async () => "queued",
    (request) => {
      if (!request.url.endsWith("/targets")) return fixture.fetch(request);
      stalled = true;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
    },
  );
  worker.start();
  await until(() => stalled);
  await worker.stop();
});
