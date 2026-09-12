import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "../server/artifact-storage.ts";
import { ArtifactClient } from "../shared/artifact-client.ts";
import { type ArtifactCommandContext, runArtifactCommand } from "./artifact-commands.ts";

let root: string;
let storage: ArtifactStorage;
let api: ReturnType<typeof createArtifactApi>;
let ctx: ArtifactCommandContext;
let output: Uint8Array[];
let errors: string[];
const agent = { role: "agent" as const, sessionId: "generic-agent" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-artifact-command-"));
  const publisher = join(root, "publisher");
  await mkdir(publisher);
  await writeFile(join(publisher, "index.html"), "<h1>First</h1>\n");
  await writeFile(join(publisher, "data.bin"), new Uint8Array([0, 255, 42]));
  storage = await openArtifactStorage({ databasePath: join(root, "daemon", "store.sqlite") });
  const token = randomBytes(32).toString("base64url");
  api = createArtifactApi(storage, {
    token,
    version: "test",
    requireLogin: false,
    allowedHost: (host) => host === "localhost",
  });
  const client = new ArtifactClient({
    url: "http://localhost",
    token,
    fetch: async (request) => {
      request.headers.set("host", "localhost");
      return api.app.request(request);
    },
  });
  output = [];
  errors = [];
  ctx = {
    client,
    cwd: publisher,
    environment: { R3_AGENT_SESSION: agent.sessionId },
    stdin: async () => "From stdin",
    write: (text) => output.push(typeof text === "string" ? new TextEncoder().encode(text) : text),
    error: (text) => errors.push(text),
  };
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
async function command(name: string, args: string[]) {
  output = [];
  const code = await runArtifactCommand(name, args, ctx);
  return { code, text: Buffer.concat(output).toString(), bytes: Buffer.concat(output) };
}
async function create() {
  const result = await command("create", [
    "--dir",
    ".",
    "--kind",
    "html",
    "--title",
    "Page",
    "--json",
  ]);
  return JSON.parse(result.text).artifact.id as string;
}

describe("artifact CLI over the HTTP contract", () => {
  test("listen selects its default identity with the local harness target", async () => {
    const id = await create();
    ctx.environment = {
      CLAUDE_CODE_SESSION_ID: "incomplete-claude",
      CODEX_THREAD_ID: "codex-target",
    };
    let connected: unknown;
    ctx.listen = async (_id, actor) => {
      connected = actor;
      return 0;
    };
    await command("listen", [id]);
    expect(connected).toEqual({ role: "agent", sessionId: "codex-target" });
    await command("listen", [id, "--session", "logical-subagent"]);
    expect(connected).toEqual({ role: "agent", sessionId: "logical-subagent" });
  });
  test("a generic publisher uploads complete versions and reads them after its directory disappears", async () => {
    await ctx.client.checkProtocol();
    const id = await create();
    await writeFile(join(ctx.cwd, "index.html"), "<h1>Second</h1>\n");
    await command("publish", [id, "--dir", ".", "--key", "second"]);
    expect(storage.artifacts.versions(id)).toHaveLength(2);
    await command("publish", [id, "--dir", ".", "--key", "second"]);
    expect(storage.artifacts.versions(id)).toHaveLength(2);
    await expect(command("publish", [id, "--dir", ".", "--expected", "1"])).rejects.toMatchObject({
      status: 409,
    });
    expect(errors[0]).toContain("retry key:");
    await rm(ctx.cwd, { recursive: true });
    expect(
      (await command("source", [id, "--version", "1", "--file", "index.html"])).text,
    ).toContain("First");
    expect(
      (await command("source", [id, "--version", "2", "--file", "index.html"])).text,
    ).toContain("Second");
    expect((await command("download", [id, "--version", "1", "--file", "data.bin"])).bytes).toEqual(
      Buffer.from([0, 255, 42]),
    );
    expect(
      JSON.parse((await command("list", ["--mine", "--json"])).text).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([id]);
    expect(storage.artifacts.get(id).createdBy).toEqual(agent);
  });

  test("native rendered feedback and explicit reply context survive independent agent sessions", async () => {
    const id = await create();
    const feedback = JSON.parse(
      (
        await command("feedback", [
          "add",
          id,
          "--human",
          "-m",
          "Change this heading",
          "--version",
          "1",
          "--view",
          "rendered",
          "--file",
          "index.html",
          "--selector",
          "h1",
          "--quote",
          "First",
          "--route",
          "#intro",
        ])
      ).text,
    );
    expect(feedback.target.locator).toMatchObject({ selector: "h1", route: "#intro" });
    await command("claim", [feedback.id]);
    await command("reply", [
      feedback.id,
      "--session",
      "second-agent",
      "-m",
      "I also inspected it",
      "--version",
      "1",
      "--view",
      "rendered",
    ]);
    expect(storage.conversations.get(feedback.id).claim?.sessionId).toBe(agent.sessionId);
    const reply = JSON.parse(
      (
        await command("reply", [
          feedback.id,
          "-m",
          "Working on the heading",
          "--version",
          "1",
          "--view",
          "rendered",
        ])
      ).text,
    );
    expect(reply.context).toEqual({ versionSeq: 1, representation: "rendered" });
    expect(storage.conversations.get(feedback.id).claim).toBeNull();
    expect(storage.conversations.get(feedback.id).status).toBe("open");
    await expect(
      command("feedback", ["edit", feedback.id, "--status", "resolved"]),
    ).rejects.toMatchObject({ status: 400 });
    await command("feedback", ["edit", feedback.id, "--human", "--status", "resolved"]);
    expect(storage.conversations.get(feedback.id).status).toBe("resolved");
  });

  test("prompt reads and watch exits preserve owner handoff and archive terminal precedence", async () => {
    const id = await create();
    const feedback = JSON.parse(
      (await command("feedback", ["add", id, "--human", "-m", "Human note"])).text,
    );
    expect((await command("prompt", [id, "--all"])).text).toContain("Human note");
    expect(storage.conversations.get(feedback.id).sentAt).toBeNull();
    expect((await command("watch", [id])).code).toBe(10);
    expect(storage.conversations.get(feedback.id).sentAt).not.toBeNull();
    expect((await command("watch", [id, "--timeout", "0.01"])).code).toBe(2);
    await command("feedback", ["add", id, "--human", "-m", "Still pending"]);
    await command("archive", [id, "--human", "-m", "Saved archive message", "--key", "terminal"]);
    const result = await command("watch", [id]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("Saved archive message");
    const expired = await command("watch", [id, "--timeout", "0.000001"]);
    expect(expired.code).toBe(0);
    expect(expired.text).toContain("Saved archive message");
    await command("restore", [id, "--human", "--key", "restore"]);
    expect(storage.conversations.unsent(id)).toHaveLength(1);
  });

  test("invalid capture and target flags fail before changing artifact state", async () => {
    await expect(command("create", ["--dir", ".", "--stdin-diff"])).rejects.toThrow("exactly one");
    await expect(command("create", ["--dir", ".", "--entrypoint", "index.html"])).rejects.toThrow(
      "Only HTML",
    );
    expect(storage.artifacts.list()).toEqual([]);
    await expect(
      command("reply", ["feedback_missing", "-m", "test", "--file", "index.html"]),
    ).rejects.toThrow("not supported");
    ctx.environment = {};
    await expect(command("create", ["--dir", "."])).rejects.toThrow("stable agent ID");
    expect(storage.artifacts.list()).toEqual([]);
  });

  test("stdin patches become independent published versions without any git checkout", async () => {
    const patch =
      "diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-before\n+after\n";
    ctx.stdin = async () => patch;
    const result = JSON.parse((await command("create", ["--stdin-diff", "--json"])).text);
    expect(result.artifact.kind).toBe("diff");
    expect((await command("patch", [result.artifact.id, "--version", "1"])).text).toBe(patch);
    const feedback = JSON.parse(
      (
        await command("feedback", [
          "add",
          result.artifact.id,
          "-m",
          "Inspect the removed text",
          "--version",
          "1",
          "--view",
          "diff",
          "--file",
          "code.txt",
          "--line",
          "1",
          "--quote",
          "before",
          "--side",
          "old",
        ])
      ).text,
    );
    expect(feedback.target.locator.side).toBe("old");
  });
});
