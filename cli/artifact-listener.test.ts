import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "../server/artifact-storage.ts";
import { ArtifactClient } from "../shared/artifact-client.ts";
import {
  listenArtifactConnection,
  localArtifactDelivery,
  startArtifactListenerProcess,
} from "./artifact-listener.ts";

let root: string;
let storage: ArtifactStorage;
let api: ReturnType<typeof createArtifactApi>;
let client: ArtifactClient;
let requests: { path: string; body: unknown }[];
let id: string;
let token: string;
const actor = { role: "agent" as const, sessionId: "publisher-agent" };
const human = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-local-listener-"));
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  token = randomBytes(32).toString("base64url");
  api = createArtifactApi(storage, {
    token,
    requireLogin: false,
    version: "test",
    allowedHost: (host) => host === "localhost",
  });
  storage.artifacts.registerSession({ id: actor.sessionId });
  id = storage.artifacts.create({ kind: "files", actor: human }).id;
  requests = [];
  client = new ArtifactClient({
    url: "http://localhost",
    token,
    fetch: async (request) => {
      const body = request.method === "GET" ? null : await request.text();
      requests.push({
        path: new URL(request.url).pathname,
        body: body === null ? null : JSON.parse(body),
      });
      request = new Request(request, { body });
      request.headers.set("host", "localhost");
      return api.app.request(request);
    },
  });
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});

describe("publisher-side listener", () => {
  test("cancelling the real outward HTTP stream releases its designated slot", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: api.app.fetch,
      idleTimeout: 30,
    });
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const remote = new ArtifactClient({ url: `http://localhost:${server.port}`, token });
    const listening = listenArtifactConnection(remote, id, actor, {
      signal: controller.signal,
      ready: () => ready.resolve(),
      deliver: async () => {},
    });
    try {
      await ready.promise;
      expect(api.collaboration.watching(id)).toBe(true);
      controller.abort();
      await expect(listening).rejects.toThrow();
      const deadline = Date.now() + 1000;
      while (api.collaboration.watching(id) && Date.now() < deadline) await Bun.sleep(5);
      expect(api.collaboration.watching(id)).toBe(false);
    } finally {
      controller.abort();
      server.stop(true);
    }
  });
  test("acknowledges only after local delivery and stops after the archived connection closes", async () => {
    const ready = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const messages: string[] = [];
    const listening = listenArtifactConnection(client, id, actor, {
      ready: () => ready.resolve(),
      deliver: async (text) => {
        messages.push(text);
        delivered.resolve();
        await release.promise;
      },
    });
    await ready.promise;
    const transition = api.collaboration.transition(id, {
      actor: human,
      event: "archived",
      operationKey: "archive",
      message: "Proceed with the saved plan",
    });
    await delivered.promise;
    expect(storage.artifacts.get(id).state).toBe("archived");
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ actor });
    release.resolve();
    expect((await transition).notification.state).toBe("sent");
    expect(await listening).toBe("archived");
    expect(messages[0]).toContain("Proceed with the saved plan");
    expect(messages[0]).not.toContain("Run: r3 prompt");
    expect(requests[1].body).toMatchObject({ actor, ok: true });
  });

  test("a failed local adapter reports a generic acknowledgment and leaves human feedback undelivered", async () => {
    await storage.conversations.add(id, {
      actor: human,
      body: "Pending feedback",
      target: { kind: "artifact" },
    });
    const ready = Promise.withResolvers<void>();
    const listening = listenArtifactConnection(client, id, actor, {
      ready: () => ready.resolve(),
      deliver: async () => {
        throw new Error("Private adapter diagnostic");
      },
    });
    const rejected = listening.catch((error: Error) => error);
    await ready.promise;
    expect((await api.collaboration.submit(id)).state).toBe("failed");
    expect(await rejected).toBeInstanceOf(Error);
    expect(((await rejected) as Error).message).toContain("Local harness delivery failed");
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    expect(api.collaboration.watching(id)).toBe(false);
    expect(requests[1].body).toMatchObject({ ok: false, error: "Local harness delivery failed" });
    expect(JSON.stringify(requests)).not.toContain("Private adapter diagnostic");
    await expect(localArtifactDelivery({})).rejects.toMatchObject({ exitCode: 5 });
  });

  test("disconnecting a held connection releases presence without a harness wake", async () => {
    const ready = Promise.withResolvers<void>();
    const controller = new AbortController();
    let calls = 0;
    const listening = listenArtifactConnection(client, id, actor, {
      signal: controller.signal,
      ready: () => ready.resolve(),
      deliver: async () => {
        calls++;
      },
    });
    await ready.promise;
    // The in-process HTTP fixture has no socket to propagate abort; closing the
    // API models transport shutdown and closes the exact registered stream.
    api.close();
    expect(await listening).toBe("disconnected");
    expect(calls).toBe(0);
    expect(api.collaboration.watching(id)).toBe(false);
  });
});

test("background listener waits for IPC readiness and reports a pre-registration failure", async () => {
  const file = join(root, "listener-child.ts");
  await writeFile(file, "process.send?.({ready: true}); setInterval(() => {}, 1000);\n");
  const pid = await startArtifactListenerProcess({
    argv: [process.execPath, file],
    environment: {},
    cwd: root,
  });
  try {
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 0);
  } finally {
    process.kill(pid, "SIGTERM");
  }
  await writeFile(
    file,
    'process.send?.({error: "Local adapter unavailable", exitCode: 5}); setInterval(() => {}, 1000);\n',
  );
  await expect(
    startArtifactListenerProcess({ argv: [process.execPath, file], environment: {}, cwd: root }),
  ).rejects.toMatchObject({ exitCode: 5, message: "Local adapter unavailable" });
});
