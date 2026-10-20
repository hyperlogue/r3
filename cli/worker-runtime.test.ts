import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AntigravityListenerTarget, ListenerTarget } from "../shared/types.ts";
import type { WorkerSubscription } from "../shared/worker-protocol.ts";
import type { AgentProcess } from "./agent-process.ts";
import { BackendCredentials } from "./backend.ts";
import { WorkerProtocolFixture } from "./worker-protocol-fixture.ts";
import { WorkerRuntime } from "./worker-runtime.ts";
import { type WorkerTarget, WorkerTargets } from "./worker-targets.ts";

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
async function savedTargets(): Promise<WorkerTarget[]> {
  const directory = join(root, "worker-targets");
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => Bun.file(join(directory, name)).json()),
  );
}
function runtime(destinations?: WorkerTargets) {
  return new WorkerRuntime(
    join(root, "worker-state.json"),
    credentials,
    async (_target, text) => {
      delivered.push(text);
      return "queued";
    },
    fixture.fetch,
    destinations,
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
async function subscribe(
  url: string,
  localTarget: ListenerTarget = { harness: "codex", threadId: "fixture-thread" },
  agentProcess?: AgentProcess,
) {
  const target = await worker.target(url, actor, localTarget, agentProcess);
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
test("Antigravity delivery survives worker restart with private credentials and reports queue failure", async () => {
  const executable = join(root, "agy");
  const output = join(root, "agentapi.json");
  await Bun.write(
    executable,
    `#!${process.execPath}
await Bun.write(${JSON.stringify(output)}, JSON.stringify({
  argv: process.argv.slice(2),
  address: process.env.ANTIGRAVITY_LS_ADDRESS,
  token: process.env.ANTIGRAVITY_CSRF_TOKEN,
  conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID,
  sourceMetadata: process.env.ANTIGRAVITY_SOURCE_METADATA,
}));
`,
  );
  await chmod(executable, 0o700);
  const target: AntigravityListenerTarget = {
    harness: "antigravity",
    executable,
    address: "localhost:43210",
    token: "private-antigravity-fixture-token",
    conversationId: "fixture-agy-conversation",
    sourceMetadata: '{"runCommand":{"cascadeId":"fixture-agy-conversation"}}',
  };
  const requests: string[] = [];
  const path = join(root, "worker-state.json");
  const createWorker = () =>
    new WorkerRuntime(path, credentials, undefined, async (request) => {
      if (request.body) requests.push(await request.clone().text());
      return fixture.fetch(request);
    });
  await worker.stop();
  worker = createWorker();
  const subscription = await subscribe(one, target);
  expect(await Bun.file(output).exists()).toBe(false);
  expect((await savedTargets())[0]!.target).toEqual(target);
  expect((await Bun.file(path).json()).targets).toBeUndefined();
  const targetFiles = await readdir(join(root, "worker-targets"));
  expect((await stat(join(root, "worker-targets", targetFiles[0]!))).mode & 0o777).toBe(0o600);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await worker.stop();
  worker = createWorker();
  worker.start();
  await until(() =>
    worker.status().subscriptions.some((item) => item.artifactId === subscription.artifactId),
  );
  expect(await Bun.file(output).exists()).toBe(false);
  fixture.send(one, nudge(subscription));
  await until(() => fixture.backends.get(one)!.acknowledgments.length === 1);
  expect(fixture.backends.get(one)!.acknowledgments[0]).toMatchObject({
    ok: true,
    state: "queued",
  });
  const received = await Bun.file(output).json();
  expect(received).toMatchObject({
    address: target.address,
    token: target.token,
    conversationId: target.conversationId,
    sourceMetadata: target.sourceMetadata,
  });
  expect(received.argv.slice(0, 5)).toEqual([
    "agentapi",
    "send-message",
    "--title=r3",
    "--",
    target.conversationId,
  ]);
  expect(received.argv[5]).toContain(`r3 comment fetch ${subscription.artifactId}`);
  for (const privateValue of [target.token, target.address, target.executable!]) {
    expect(requests.join("\n")).not.toContain(privateValue);
    expect(JSON.stringify(worker.status())).not.toContain(privateValue);
  }
  await rm(executable);
  fixture.send(one, nudge(subscription));
  await until(() => fixture.backends.get(one)!.acknowledgments.length === 2);
  expect(fixture.backends.get(one)!.acknowledgments[1]).toMatchObject({ ok: false });
  expect(
    worker.status().subscriptions.some((item) => item.artifactId === subscription.artifactId),
  ).toBe(true);
});
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
      comment: null,
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
  expect(saved.version).toBe(3);
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

test("a rate-limited OAuth refresh retries without requiring login", async () => {
  await worker.stop();
  let refreshes = 0;
  credentials = new BackendCredentials(join(root, "credentials"), (async (
    _url: unknown,
    _options: RequestInit,
  ) => {
    if (++refreshes === 1) return new Response(null, { status: 429 });
    return Response.json({
      access_token: fixture.backends.get(one)!.token,
      refresh_token: randomBytes(32).toString("hex"),
      expires_in: 900,
      token_type: "Bearer",
    });
  }) as typeof fetch);
  await credentials.save({
    url: one,
    kind: "oauth",
    accessToken: "expired",
    refreshToken: randomBytes(32).toString("hex"),
    expiresAt: 0,
  });
  worker = runtime();
  const subscription = await subscribe(one);
  expect(refreshes).toBe(2);
  expect(worker.status().backends[0]?.state).toBe("ready");
  fixture.send(one, nudge(subscription));
  await until(() => delivered.length === 1);
});
for (const malformed of [false, true]) {
  test(`worker discards a legacy import without changing current destinations (malformed: ${malformed})`, async () => {
    const subscription = await subscribe(one);
    const path = join(root, "worker-state.json");
    const saved = await Bun.file(path).json();
    const importPath = join(root, "worker-import.json");
    await worker.stop();
    await Bun.write(
      importPath,
      malformed
        ? "invalid legacy JSON"
        : JSON.stringify({
            url: two,
            listeners: [
              {
                id: "legacy-subscription",
                artifactId: "legacy-artifact",
                actor: { role: "agent", sessionId: "legacy-agent" },
                mode: "fallback",
                target: { harness: "codex", threadId: "legacy-thread" },
              },
            ],
          }),
    );
    worker = runtime();
    expect(await Bun.file(importPath).exists()).toBe(false);
    expect(await Bun.file(path).json()).toEqual(saved);
    worker.start();
    await until(() => worker.status().backends[0]?.state === "ready");
    expect(fixture.backends.get(two)!.connects).toBe(0);
    fixture.send(one, nudge(subscription));
    await until(() => delivered.length === 1);
    const fresh = await subscribe(two);
    fixture.send(two, nudge(fresh));
    await until(() => delivered.length === 2);
  });
}
test("stopping the worker cancels a stalled backend connection", async () => {
  await subscribe(one);
  await worker.stop();
  let stalled = false;
  worker = new WorkerRuntime(
    join(root, "worker-state.json"),
    credentials,
    async () => "queued",
    (request) => {
      if (!request.url.endsWith("/connect")) return fixture.fetch(request);
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

test("normal stream and status operations clean dead owners even when a backend is unavailable", async () => {
  await worker.stop();
  let now = 0;
  const dead = new Set<number>();
  const owner: AgentProcess = {
    pid: 123,
    platform: "linux",
    bootId: "boot",
    namespace: "pid:[1]",
    startedAt: "10",
  };
  const store = new WorkerTargets(join(root, "worker-state.json"), {
    now: () => now,
    processes: () => ({
      localIdentity: (value) => value,
      liveness: (value) => (dead.has(value.pid) ? "dead" : "alive"),
    }),
  });
  worker = runtime(store);
  const first = await subscribe(one, undefined, owner);
  await subscribe(two, undefined, { ...owner, pid: 456 });
  fixture.backends.get(two)!.token = "revoked";
  fixture.disconnect(two);
  await until(() => worker.status().backends.some((value) => value.state === "login-required"));
  dead.add(123);
  dead.add(456);
  now = 60_000;
  fixture.send(one, { type: "heartbeat" });
  // Do not poll status here: prove that the incoming frame triggers cleanup.
  await until(() => store.list().length === 0);
  expect(await savedTargets()).toHaveLength(0);
  // Authorship and backend subscriptions remain authoritative and untouched.
  expect(fixture.backends.get(one)!.subscriptions.has(first.id)).toBe(true);
  dead.clear();
  await subscribe(one, undefined, owner);
  dead.add(owner.pid);
  now += 60_000;
  worker.status();
  expect(store.list()).toHaveLength(0);
});

test("delivery checks process exit immediately without waiting for the next sweep", async () => {
  await worker.stop();
  let dead = false;
  const owner: AgentProcess = {
    pid: 123,
    platform: "linux",
    bootId: "boot",
    namespace: "pid:[1]",
    startedAt: "10",
  };
  const store = new WorkerTargets(join(root, "worker-state.json"), {
    now: () => 0,
    processes: () => ({
      localIdentity: (value) => value,
      liveness: () => (dead ? "dead" : "alive"),
    }),
  });
  worker = runtime(store);
  const subscription = await subscribe(one, undefined, owner);
  dead = true;
  fixture.send(one, nudge(subscription));
  await until(() => fixture.backends.get(one)!.acknowledgments.length === 1);
  expect(delivered).toHaveLength(0);
  expect(fixture.backends.get(one)!.acknowledgments[0]).toMatchObject({ ok: false });
  expect(store.list()).toHaveLength(0);
  expect(await savedTargets()).toHaveLength(0);
});

test("reconnect prunes thousands of stale destinations without setup replay and preserves every subscribed role", async () => {
  await worker.stop();
  const path = join(root, "worker-state.json");
  const saved = await Bun.file(path).json();
  const targets = Array.from({ length: 5000 }, (_, index) => ({
    id: `destination-${index}`,
    url: one,
    actor: { role: "agent" as const, sessionId: `agent-${index}` },
    target: { harness: "codex", threadId: `thread-${index}` },
  }));
  const retained: WorkerSubscription[] = (["explicit", "fallback", "explicit"] as const).map(
    (mode, index) => ({
      id: `subscription-${index}`,
      artifactId: index === 2 ? "another-artifact" : "artifact",
      listenerId: targets[index % 2]!.id,
      actor: targets[index % 2]!.actor,
      mode,
    }),
  );
  for (const subscription of retained)
    fixture.backends.get(one)!.subscriptions.set(subscription.id, { ...subscription });
  await Bun.write(
    path,
    JSON.stringify({ ...saved, version: 2, targets: [...targets, { ...targets[0], url: two }] }),
  );
  worker = runtime();
  const fresh = await worker.target(one, actor, { harness: "codex", threadId: "fresh" });
  await until(() => worker.status().subscriptions.length === 3);
  expect(fixture.backends.get(one)!.requests).toEqual(["/api/workers/connect"]);
  const destinations = savedTargets;
  let local = (await destinations()).filter((value) => value.url === one);
  expect(local).toHaveLength(4098);
  expect(local.map((value) => value.id)).toEqual(
    expect.arrayContaining(["destination-0", "destination-1", fresh.listenerId]),
  );
  expect(local.some((value) => value.id === "destination-2")).toBe(false);
  for (const subscription of retained) fixture.send(one, nudge(subscription));
  await until(() => delivered.length === 3);
  fixture.send(one, { type: "retired", registrationId: retained[0]!.id });
  await until(() => worker.status().subscriptions.length === 2);
  fixture.send(one, { type: "heartbeat" });
  fixture.send(one, nudge(retained[2]!));
  await until(() => delivered.length === 4);
  fixture.send(one, { type: "retired", registrationId: retained[2]!.id });
  await until(() => worker.status().subscriptions.length === 1);
  fixture.send(one, { type: "heartbeat" });
  fixture.send(one, nudge(retained[1]!));
  await until(() => delivered.length === 5);
  local = (await destinations()).filter((value) => value.url === one);
  expect(local).toHaveLength(4097);
  expect(local.map((value) => value.id)).toEqual(
    expect.arrayContaining(["destination-1", fresh.listenerId]),
  );
  expect((await destinations()).filter((value) => value.url === two)).toEqual([
    expect.objectContaining({ id: "destination-0", url: two }),
  ]);
}, 60_000);

test("an older backend without a destination snapshot preserves saved destinations", async () => {
  const subscription = await subscribe(one);
  await worker.stop();
  const path = join(root, "worker-state.json");
  const saved = await Bun.file(path).json();
  const targets = await savedTargets();
  for (let index = 0; index < 5000; index++)
    targets.push({ ...targets[0]!, id: `unused-${index}` });
  await Bun.write(path, JSON.stringify({ ...saved, version: 2, targets }));
  fixture.destinationSnapshot = false;
  worker = runtime();
  worker.start();
  await until(() => worker.status().subscriptions.length === 1);
  expect(await savedTargets()).toHaveLength(5001);
  fixture.send(one, nudge(subscription));
  await until(() => delivered.length === 1);
}, 60_000);
