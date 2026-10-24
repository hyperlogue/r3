import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListenerTarget } from "../shared/types.ts";
import {
  type AgentProcess,
  AgentProcesses,
  captureAgentProcess,
  findAgentAncestor,
  type ProcessEntry,
  parseAgentProcess,
  parseLinuxProcess,
} from "./agent-process.ts";
import { WorkerTargets } from "./worker-targets.ts";

const harnesses: { name: string; target: ListenerTarget }[] = [
  { name: "codex", target: { harness: "codex", threadId: "fixture" } },
  { name: "claude", target: { harness: "claude", socket: "/fixture.sock", token: "fixture" } },
  {
    name: "agy",
    target: {
      harness: "antigravity",
      conversationId: "fixture",
      address: "localhost:1234",
      token: "fixture",
    },
  },
];

for (const { name, target } of harnesses)
  for (const sandboxed of [true, false])
    test.if(process.platform === "linux")(
      sandboxed
        ? `${target.harness} destination survives a sandbox helper with the agent's process name exiting`
        : `${target.harness} destination expires after a verified agent exits`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "r3-agent-sandbox-"));
        const helper = join(root, sandboxed ? `${name}-sandbox-helper` : name);
        await symlink(process.execPath, helper);
        const capture = `
        import { captureAgentProcess } from ${JSON.stringify(new URL("./agent-process.ts", import.meta.url).href)};
        console.log(JSON.stringify(captureAgentProcess(${JSON.stringify(target)}) ?? null));
      `;
        const launcher = Bun.spawn(
          [
            helper,
            "-e",
            `
            import { writeFileSync } from "node:fs";
            writeFileSync("/proc/self/comm", ${JSON.stringify(name)});
            const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(capture)}], {
              env: { ...process.env, R3_AGENT_PID: undefined },
              stdin: "ignore", stdout: "pipe", stderr: "inherit",
            });
            const output = await new Response(child.stdout).text();
            if (await child.exited !== 0) process.exit(1);
            console.log(output.trim());
            await Bun.stdin.text();
          `,
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 5000 },
        );
        try {
          let output = "";
          const reader = launcher.stdout.getReader();
          while (!output.includes("\n")) {
            const { done, value } = await reader.read();
            if (done) throw new Error("Sandbox helper exited before process capture");
            output += new TextDecoder().decode(value);
          }
          reader.releaseLock();
          const owner = JSON.parse(output.trim()) as AgentProcess | null;
          const store = new WorkerTargets(join(root, "worker-state.json"));
          const destination = store.bind(
            "https://fixture.example",
            { role: "agent", sessionId: "fixture" },
            target,
            owner ?? undefined,
          );
          launcher.stdin.end();
          expect(await launcher.exited).toBe(0);
          if (sandboxed) {
            expect(store.forDelivery(destination.url, destination.id)).toBeDefined();
            expect(owner?.pid).not.toBe(launcher.pid);
          } else {
            expect(owner?.pid).toBe(launcher.pid);
            expect(store.forDelivery(destination.url, destination.id)).toBeUndefined();
          }
        } finally {
          launcher.kill();
          await launcher.exited;
          await rm(root, { recursive: true, force: true });
        }
      },
    );

test("agent discovery walks past short-lived shells and selects the nearest matching harness, including PID 1", () => {
  const entry = (pid: number, parentPid: number, name: string): ProcessEntry => ({
    pid,
    parentPid,
    name,
    uid: 1,
    startedAt: "123",
    dead: false,
  });
  const entries = new Map([
    [40, entry(40, 30, "bash")],
    [30, entry(30, 20, "sh")],
    [20, entry(20, 10, ".agy-wrapped")],
    [10, entry(10, 1, "agy")],
    [1, entry(1, 0, "codex")],
  ]);
  const commandName = (pid: number) => entries.get(pid)?.name;
  expect(
    findAgentAncestor(
      { harness: "antigravity", conversationId: "c", address: "localhost:1", token: "t" },
      (pid) => entries.get(pid),
      40,
      commandName,
    ),
  ).toBe(20);
  expect(
    findAgentAncestor(
      { harness: "codex", threadId: "c" },
      (pid) => entries.get(pid),
      40,
      commandName,
    ),
  ).toBe(1);
  expect(
    findAgentAncestor(
      { harness: "claude", socket: "s", token: "t" },
      (pid) => entries.get(pid),
      40,
      commandName,
    ),
  ).toBeUndefined();
  entries.get(20)!.parentPid = 30;
  expect(
    findAgentAncestor(
      { harness: "codex", threadId: "c" },
      (pid) => entries.get(pid),
      40,
      commandName,
    ),
  ).toBeUndefined();
});

for (const { name, target } of harnesses)
  test(`${target.harness} discovery skips helpers and preserves hidden or unreadable owners`, () => {
    const entries = new Map<number, ProcessEntry>([
      [30, { pid: 30, parentPid: 20, uid: 1, name: "sh", startedAt: "3", dead: false }],
      [20, { pid: 20, parentPid: 10, uid: 1, name, startedAt: "2", dead: false }],
      [10, { pid: 10, parentPid: 0, uid: 1, name, startedAt: "1", dead: false }],
    ]);
    const read = (pid: number) => entries.get(pid);
    const commandName = (pid: number) => (pid === 10 ? `/opt/agents/${name}` : "sandbox-runner");
    expect(findAgentAncestor(target, read, 30, commandName)).toBe(10);
    expect(findAgentAncestor(target, read, 30, () => undefined)).toBeUndefined();
    entries.delete(10);
    expect(findAgentAncestor(target, read, 30, commandName)).toBeUndefined();
  });

test("Linux process parsing handles parentheses in comm, start identity and zombies", () => {
  const fields = ["Z", "12", ...Array(17).fill("0"), "987654", "0"];
  expect(parseLinuxProcess(`34 (agent (worker)) ${fields.join(" ")}`, 100)).toEqual({
    pid: 34,
    parentPid: 12,
    uid: 100,
    name: "agent (worker)",
    startedAt: "987654",
    dead: true,
  });
  expect(parseLinuxProcess("not a process", 100)).toBeUndefined();
});

test("process identity rejects malformed private IPC input", () => {
  const valid = {
    pid: 1,
    platform: "linux",
    bootId: "boot",
    namespace: "pid:[1]",
    startedAt: "123",
  } as const;
  expect(parseAgentProcess(valid)).toEqual(valid);
  for (const change of [
    { pid: 0 },
    { pid: 2.5 },
    { pid: "123" },
    { pid: 2147483648 },
    { platform: "other" },
    { namespace: "" },
    { bootId: "a\nb" },
    { startedAt: "x".repeat(129) },
  ])
    expect(parseAgentProcess({ ...valid, ...change })).toBeNull();
});

test("a recorded child process becomes dead after exit; PID reuse and foreign namespaces are distinguished", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const owner = new AgentProcesses().identity(child.pid);
    expect(owner).toBeDefined();
    expect(new AgentProcesses().liveness(owner!)).toBe("alive");
    expect(new AgentProcesses().liveness({ ...owner!, startedAt: "different-start" })).toBe("dead");
    expect(new AgentProcesses().liveness({ ...owner!, bootId: "previous-boot" })).toBe("dead");
    expect(new AgentProcesses().liveness({ ...owner!, namespace: "inaccessible-namespace" })).toBe(
      "unknown",
    );
    expect(new AgentProcesses().localIdentity(owner!)).toEqual(owner!);
    child.kill();
    await child.exited;
    expect(new AgentProcesses().liveness(owner!)).toBe("dead");
  } finally {
    child.kill();
    await child.exited;
  }
});

test("explicit agent PID captures a live owner and rejects stale or invalid overrides", () => {
  const target = { harness: "codex", threadId: "fixture" } as const;
  expect(captureAgentProcess(target, { R3_AGENT_PID: String(process.pid) })?.pid).toBe(process.pid);
  for (const value of ["0", "-1", "1.1", "not-a-pid", "2147483647"])
    expect(() => captureAgentProcess(target, { R3_AGENT_PID: value })).toThrow("R3_AGENT_PID");
});
