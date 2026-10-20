import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProcess } from "./agent-process.ts";
import { writePrivateJson } from "./private-state.ts";
import { PROCESS_SWEEP_INTERVAL_MS, WorkerTargets } from "./worker-targets.ts";

let root: string;
const url = "https://backend.example";
const actor = { role: "agent", sessionId: "agent-a" } as const;
const target = { harness: "codex", threadId: "thread-a" } as const;
const owner: AgentProcess = {
  pid: 123,
  platform: "linux",
  bootId: "fixture-boot",
  namespace: "fixture-ns",
  startedAt: "456",
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-worker-targets-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const statePath = () => join(root, "worker-state.json");

for (const version of [1, 2])
  test(`aggregate v${version} migration preserves destination IDs and removes embedded credentials`, async () => {
    writePrivateJson(statePath(), {
      version,
      workerId: "stable-worker",
      targets: [
        { id: "same-destination", url, actor, target },
        {
          id: "same-destination",
          url: "https://other.example",
          actor,
          target: {
            harness: "antigravity",
            conversationId: "c",
            address: "localhost:1234",
            token: "private-token",
          },
        },
      ],
      subscriptions: [{ obsolete: true }],
    });
    const store = new WorkerTargets(statePath());
    expect(await Bun.file(statePath()).json()).toEqual({ version: 3, workerId: "stable-worker" });
    expect(store.list()).toHaveLength(2);
    expect(store.get(url, "same-destination")?.target).toEqual(target);
    expect((await readdir(store.directory)).length).toBe(2);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(store.directory))
      expect((await stat(join(store.directory, name))).mode & 0o777).toBe(0o600);
    expect(new WorkerTargets(statePath()).list()).toEqual(store.list());
  });

test("an interrupted migration replays safely before retiring the aggregate", async () => {
  const old = { version: 2, workerId: "worker", targets: [{ id: "d", url, actor, target }] };
  writePrivateJson(statePath(), old);
  const first = new WorkerTargets(statePath());
  const names = await readdir(first.directory);
  // The destination was written, but the process stopped before the final metadata rename.
  writePrivateJson(statePath(), old);
  await Bun.write(join(first.directory, names[0]!), "interrupted file");
  const recovered = new WorkerTargets(statePath());
  expect(recovered.get(url, "d")?.target).toEqual(target);
  expect(await Bun.file(statePath()).json()).toEqual({ version: 3, workerId: "worker" });
});

test("refreshing one destination leaves other credential files and worker identity unchanged", async () => {
  const store = new WorkerTargets(statePath());
  const first = store.bind(url, actor, target);
  const second = store.bind(
    url,
    { ...actor, sessionId: "agent-b" },
    { ...target, threadId: "thread-b" },
  );
  const files = await readdir(store.directory);
  const otherFile = (
    await Promise.all(
      files.map(async (name) => ({
        name,
        body: await Bun.file(join(store.directory, name)).json(),
      })),
    )
  ).find((item) => item.body.id === second.id)!.name;
  const before = await readFile(join(store.directory, otherFile), "utf8");
  const metadata = await stat(statePath());
  expect(store.bind(url, actor, { ...target, threadId: "refreshed" }).id).toBe(first.id);
  expect(await readFile(join(store.directory, otherFile), "utf8")).toBe(before);
  expect((await stat(statePath())).mtimeMs).toBe(metadata.mtimeMs);
});

test("opportunistic sweeps are throttled, preserve unknown processes, and delivery checks immediately", async () => {
  let now = 0,
    dead = false,
    probes = 0;
  const store = new WorkerTargets(statePath(), {
    now: () => now,
    processes: () => ({
      localIdentity: (value) => value,
      liveness: (value) => {
        probes++;
        return value.pid === 999 ? "unknown" : dead ? "dead" : "alive";
      },
    }),
  });
  const first = store.bind(url, actor, target, owner);
  const unknown = store.bind(url, { ...actor, sessionId: "unknown" }, target, {
    ...owner,
    pid: 999,
  });
  const legacy = store.bind(url, { ...actor, sessionId: "legacy" }, target);
  const initial = probes;
  dead = true;
  now = PROCESS_SWEEP_INTERVAL_MS - 1;
  store.sweep();
  expect(probes).toBe(initial);
  // A notification cannot use a dead owner during the batch throttle interval.
  expect(store.forDelivery(url, first.id)).toBeUndefined();
  expect(await readdir(store.directory)).toHaveLength(2);
  now++;
  store.sweep();
  expect(store.get(url, unknown.id)).toBeDefined();
  expect(store.get(url, legacy.id)).toBeDefined();
});

test("startup removes dead process records while preserving the worker ID", () => {
  const options = {
    processes: () => ({
      localIdentity: (value: AgentProcess) => value,
      liveness: () => "alive" as const,
    }),
  };
  const store = new WorkerTargets(statePath(), options);
  store.bind(url, actor, target, owner);
  const next = new WorkerTargets(statePath(), {
    processes: () => ({ localIdentity: (value) => value, liveness: () => "dead" }),
  });
  expect(next.list()).toHaveLength(0);
  expect(next.workerId).toBe(store.workerId);
});

test("startup cleans owned interrupted writes and isolates malformed files without following symlinks", async () => {
  const store = new WorkerTargets(statePath());
  const valid = store.bind(url, actor, target);
  const corrupt = store.bind(url, { ...actor, sessionId: "corrupt" }, target);
  for (const name of await readdir(store.directory)) {
    if ((await Bun.file(join(store.directory, name)).json()).id === corrupt.id)
      await Bun.write(join(store.directory, name), "{broken");
  }
  const temp = `${statePath()}.${randomUUID()}.tmp`;
  const targetTemp = join(store.directory, `${"a".repeat(64)}.json.${randomUUID()}.tmp`);
  writePrivateJson(temp, { secret: "old-copy" });
  writePrivateJson(targetTemp, { secret: "old-copy" });
  const outside = join(root, "unrelated.json");
  writePrivateJson(outside, { keep: true });
  await symlink(outside, join(store.directory, `${"b".repeat(64)}.json`));
  const next = new WorkerTargets(statePath());
  expect(next.list().map((item) => item.id)).toEqual([valid.id]);
  expect(await Bun.file(temp).exists()).toBe(false);
  expect(await Bun.file(targetTemp).exists()).toBe(false);
  expect(await Bun.file(outside).json()).toEqual({ keep: true });
});

test("a failed atomic write preserves the old record and removes its temporary credential copy", async () => {
  writePrivateJson(statePath(), { keep: true });
  const circular: Record<string, unknown> = { secret: "fixture" };
  circular.self = circular;
  expect(() => writePrivateJson(statePath(), circular)).toThrow();
  expect(await readdir(root)).toEqual(["worker-state.json"]);
  expect(await Bun.file(statePath()).json()).toEqual({ keep: true });
});
