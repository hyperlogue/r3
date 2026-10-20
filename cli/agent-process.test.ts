import { expect, test } from "bun:test";
import {
  AgentProcesses,
  captureAgentProcess,
  findAgentAncestor,
  type ProcessEntry,
  parseAgentProcess,
  parseLinuxProcess,
} from "./agent-process.ts";

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
  expect(
    findAgentAncestor(
      { harness: "antigravity", conversationId: "c", address: "localhost:1", token: "t" },
      (pid) => entries.get(pid),
      40,
    ),
  ).toBe(20);
  expect(
    findAgentAncestor({ harness: "codex", threadId: "c" }, (pid) => entries.get(pid), 40),
  ).toBe(1);
  expect(
    findAgentAncestor(
      { harness: "claude", socket: "s", token: "t" },
      (pid) => entries.get(pid),
      40,
    ),
  ).toBeUndefined();
  entries.get(20)!.parentPid = 30;
  expect(
    findAgentAncestor({ harness: "codex", threadId: "c" }, (pid) => entries.get(pid), 40),
  ).toBeUndefined();
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
