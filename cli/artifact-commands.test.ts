import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "../server/artifact-storage.ts";
import { ArtifactClient } from "../shared/artifact-client.ts";
import { type ArtifactCommandContext, runArtifactCommand } from "./artifact-commands.ts";
import { publisherGit } from "./capture-git.ts";

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
    write: (text) => {
      output.push(typeof text === "string" ? new TextEncoder().encode(text) : text);
    },
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
  test("media fixes upload snapshots and comment fetch downloads authoritative frames", async () => {
    const human = { role: "human", sessionId: null } as const;
    const artifact = storage.artifacts.create({ kind: "files", actor: human });
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(ctx.cwd, "frame.png"), bytes);
    await storage.artifacts.publish(artifact.id, {
      actor: human,
      expectedSeq: 0,
      publicationKey: "media",
      content: {
        kind: "files",
        files: [{ path: "image.png", mediaType: "image/png", base64: bytes.toString("base64") }],
      },
    });
    const note = await storage.conversations.add(artifact.id, {
      actor: human,
      body: "Fix this image",
      target: { kind: "artifact" },
    });
    const result = await command("comment", [
      note.id,
      "--version",
      "1",
      "--view",
      "media",
      "-m",
      "Fixed",
      "--target",
      JSON.stringify({ kind: "media", versionSeq: 1, path: "image.png", locator: { time: null } }),
      "--frame",
      "frame.png",
    ]);
    expect(result.code).toBe(0);
    const comment = JSON.parse(result.text);
    expect(comment.target.locator.box).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    const fetched = await command("comment", [
      "fetch",
      artifact.id,
      "--all",
      "--attachments-dir",
      "evidence",
    ]);
    expect(fetched.code).toBe(0);
    expect(fetched.text).toContain("Saved fix frame");
    expect(
      Buffer.from(
        await Bun.file(
          join(ctx.cwd, "evidence", `${comment.target.locator.frame.id}.png`),
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
  });
  test("threads source reads full original ranges on demand without delivery side effects", async () => {
    const human = { role: "human" as const, sessionId: null };
    const lines = ["first", "  second", "third", "fourth", "fifth", "sixth  ", ""];
    for (const kind of ["files", "diff"] as const) {
      const artifact = storage.artifacts.create({ kind, actor: human });
      await storage.artifacts.publish(artifact.id, {
        actor: human,
        expectedSeq: 0,
        publicationKey: kind,
        content:
          kind === "files"
            ? {
                kind,
                files: [
                  {
                    path: "code.txt",
                    mediaType: "text/plain",
                    base64: Buffer.from(`${lines.join("\r\n")}\r\n`).toString("base64"),
                  },
                ],
              }
            : {
                kind,
                patch: [
                  "diff --git a/code.txt b/code.txt",
                  "--- a/code.txt",
                  "+++ b/code.txt",
                  "@@ -1,7 +1,1 @@",
                  ...lines.map((line) => `-${line}`),
                  "+replacement",
                  "",
                ].join("\n"),
              },
      });
      const note = await storage.conversations.add(artifact.id, {
        actor: human,
        body: "Review the full range",
        target: {
          kind: kind === "files" ? "source" : "diff",
          versionSeq: 1,
          path: "code.txt",
          locator: {
            start: 1,
            end: 7,
            quote: lines.slice(0, 4).join("\n"),
            ...(kind === "diff" ? { side: "old" } : {}),
          },
        },
      });
      if (kind === "files")
        await storage.artifacts.publish(artifact.id, {
          actor: human,
          expectedSeq: 1,
          publicationKey: "newer",
          content: {
            kind,
            files: [
              {
                path: "code.txt",
                mediaType: "text/plain",
                base64: Buffer.from("newer contents").toString("base64"),
              },
            ],
          },
        });
      const snapshot = storage.conversations.snapshot(artifact.id);
      const result = await command("thread", ["source", note.id]);
      expect(result.code).toBe(0);
      expect(result.text).toBe(lines.map((line, i) => `${i + 1}\t${line}\n`).join(""));
      const json = JSON.parse((await command("thread", ["source", note.id, "--json"])).text);
      expect(json).toEqual({
        artifactId: artifact.id,
        versionSeq: 1,
        path: "code.txt",
        start: 1,
        end: 7,
        side: kind === "diff" ? "old" : null,
        text: lines.join("\n"),
      });
      expect(storage.conversations.snapshot(artifact.id)).toEqual(snapshot);
      expect(storage.conversations.get(note.id).claim).toBeNull();
      expect((await command("comment", ["fetch", artifact.id, "--all"])).text).toContain(
        `r3 thread source ${note.id}`,
      );
      const general = await storage.conversations.add(artifact.id, {
        actor: human,
        body: "General",
        target: { kind: "artifact" },
      });
      await expect(command("thread", ["source", general.id])).rejects.toThrow("no captured");
    }
    await expect(command("thread", ["source", "missing"])).rejects.toThrow("not found");
  });
  test("image-only threads uploads, downloads, retries and acknowledges only after image delivery", async () => {
    const id = await create();
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(ctx.cwd, "screen.png"), bytes);
    const args = ["add", id, "--human", "--attach", "screen.png", "--key", "image-note"];
    const note = JSON.parse((await command("thread", args)).text);
    expect(JSON.parse((await command("thread", args)).text).id).toBe(note.id);
    const image = note.comments[0].attachments[0];
    expect((await command("comment", ["image", id, "--image", image.id])).bytes).toEqual(bytes);
    await writeFile(join(ctx.cwd, "blocked"), "not a directory");
    await expect(
      command("comment", ["fetch", id, "--attachments-dir", "blocked"]),
    ).rejects.toThrow();
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
    const fetched = await command("comment", ["fetch", id, "--attachments-dir", "images"]);
    expect(fetched.text).toContain(`images/${image.id}.png`);
    expect(fetched.text).toContain(`r3 comment image ${id}`);
    expect(await Bun.file(join(ctx.cwd, "images", `${image.id}.png`)).bytes()).toEqual(
      new Uint8Array(bytes),
    );
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).not.toBeNull();
    expect(
      (await command("comment", ["fetch", id, "--all", "--attachments-dir", "images"])).code,
    ).toBe(0);
    await command("thread", [
      "edit",
      note.id,
      "--human",
      "-m",
      "Removed image",
      "--clear-attachments",
    ]);
    expect(storage.conversations.get(note.id).comments[0]!.attachments).toEqual([]);
  });
  for (const name of ["comment", "watch"]) {
    test(`${name} waits for stdout completion before acknowledgment`, async () => {
      const id = await create();
      const note = await storage.conversations.add(id, {
        actor: { role: "human", sessionId: null },
        body: "Buffered output",
        target: { kind: "artifact" },
      });
      const entered = Promise.withResolvers<void>();
      const written = Promise.withResolvers<void>();
      ctx.write = async () => {
        entered.resolve();
        await written.promise;
      };
      const running = command(name, name === "comment" ? ["fetch", id] : [id]);
      await entered.promise;
      expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
      written.resolve();
      expect((await running).code).toBe(name === "watch" ? 10 : 0);
      expect(storage.conversations.get(note.id).comments[0]!.sentAt).not.toBeNull();
    });
    test(`${name} preserves pending comments on asynchronous output failure`, async () => {
      const id = await create();
      const note = await storage.conversations.add(id, {
        actor: { role: "human", sessionId: null },
        body: "Original",
        target: { kind: "artifact" },
      });
      await command("comment", ["fetch", id]);
      const comment = await storage.conversations.addComment(note.id, {
        actor: { role: "human", sessionId: null },
        body: "New comment",
        context: { versionSeq: null, representation: null },
      });
      ctx.write = async () => {
        await Promise.resolve();
        throw new Error("Broken pipe");
      };
      await expect(command(name, name === "comment" ? ["fetch", id] : [id])).rejects.toThrow(
        "Broken pipe",
      );
      expect(storage.conversations.comment(comment.id).sentAt).toBeNull();
    });
    test(`${name} preserves pending comments when stdout fails`, async () => {
      const id = await create();
      const note = await storage.conversations.add(id, {
        actor: { role: "human", sessionId: null },
        body: "Must remain pending",
        target: { kind: "artifact" },
      });
      ctx.write = () => {
        throw new Error("Output failed");
      };
      await expect(command(name, name === "comment" ? ["fetch", id] : [id])).rejects.toThrow(
        "Output failed",
      );
      expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
      expect(storage.conversations.unsent(id).map((item) => item.id)).toEqual([note.id]);
    });
  }
  test("lost snapshot responses leave comments pending, and failed acknowledgments never register listeners", async () => {
    const id = await create();
    const note = await storage.conversations.add(id, {
      actor: { role: "human", sessionId: null },
      body: "Unread output",
      target: { kind: "artifact" },
    });
    const request = ctx.client.request.bind(ctx.client);
    ctx.client.request = async (...args) => {
      const response = await request(...args);
      if (args[1].includes("/comments/pending")) throw new Error("Lost read response");
      return response;
    };
    await expect(command("comment", ["fetch", id])).rejects.toThrow("Lost read response");
    expect(output).toEqual([]);
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
    let registrations = 0;
    ctx.environment.CODEX_THREAD_ID = "threads-caller";
    ctx.listen = async () => {
      registrations++;
      return 0;
    };
    ctx.client.request = async (...args) => {
      if (args[1].endsWith("/comments/acknowledge")) throw new Error("Acknowledgment unavailable");
      return request(...args);
    };
    await expect(command("comment", ["fetch", id])).rejects.toThrow(
      "Comments were printed, but acknowledgment was not confirmed",
    );
    expect(Buffer.concat(output).toString()).toContain("Unread output");
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
    expect(registrations).toBe(0);
  });
  test("new threads during output conflicts instead of acknowledging unseen work", async () => {
    const id = await create();
    const human = { role: "human" as const, sessionId: null };
    const note = await storage.conversations.add(id, {
      actor: human,
      body: "Read first",
      target: { kind: "artifact" },
    });
    ctx.write = async () => {
      await storage.conversations.addComment(note.id, {
        actor: human,
        body: "Arrived during output",
        context: { versionSeq: null, representation: null },
      });
    };
    await expect(command("comment", ["fetch", id])).rejects.toMatchObject({ status: 409 });
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
    expect(storage.conversations.get(note.id).comments.slice(1)[0].sentAt).toBeNull();
  });
  test("a lost acknowledgment response leaves later threads for the next fetch", async () => {
    const id = await create();
    const human = { role: "human" as const, sessionId: null };
    const note = await storage.conversations.add(id, {
      actor: human,
      body: "Already printed",
      target: { kind: "artifact" },
    });
    const request = ctx.client.request.bind(ctx.client);
    ctx.client.request = async (...args) => {
      const response = await request(...args);
      if (args[1].endsWith("/comments/acknowledge")) {
        await storage.conversations.add(id, {
          actor: human,
          body: "Arrived after acknowledgment",
          target: { kind: "artifact" },
        });
        throw new Error("Lost acknowledgment response");
      }
      return response;
    };
    await expect(command("comment", ["fetch", id])).rejects.toThrow(
      "acknowledgment was not confirmed",
    );
    expect(Buffer.concat(output).toString()).toContain("Already printed");
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).not.toBeNull();
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    ctx.client.request = request;
    const retry = await command("comment", ["fetch", id]);
    expect(retry.text).toContain("Arrived after acknowledgment");
    expect(retry.text).not.toContain("Already printed");
    expect(storage.conversations.unsent(id)).toHaveLength(0);
  });
  test("watch gives archive priority when it happens during output and preserves pending comments", async () => {
    const id = await create();
    const human = { role: "human" as const, sessionId: null };
    const note = await storage.conversations.add(id, {
      actor: human,
      body: "Pending",
      target: { kind: "artifact" },
    });
    let writes = 0;
    ctx.write = async () => {
      if (writes++ === 0)
        await api.collaboration.transition(id, {
          actor: human,
          event: "archived",
          operationKey: "archive-during-output",
          comment: {
            body: "Stop here",
          },
        });
    };
    expect((await command("watch", [id])).code).toBe(0);
    expect(writes).toBe(2);
    expect(storage.conversations.get(note.id).comments[0]!.sentAt).toBeNull();
  });
  test("creation requires kind before capture and publication labels accept one spelling", async () => {
    let stdinReads = 0;
    ctx.stdin = async () => {
      stdinReads++;
      return "Version from stdin";
    };
    await expect(command("create", ["--dir", "missing"])).rejects.toThrow("--kind");
    await expect(command("create", ["--stdin-diff"])).rejects.toThrow("--kind");
    expect(stdinReads).toBe(0);
    expect(storage.artifacts.list()).toEqual([]);
    const created = JSON.parse(
      (await command("create", ["--kind", "files", "--dir", ".", "--version-label", "-", "--json"]))
        .text,
    );
    expect(created.version.label).toBe("Version from stdin");
    expect(stdinReads).toBe(1);
    const id = created.artifact.id;
    await command("publish", [id, "--dir", ".", "--label", "Legacy spelling"]);
    expect(storage.artifacts.versions(id)[1].label).toBe("Legacy spelling");
    await command("publish", [id, "--dir", ".", "--version-label", "Preferred spelling"]);
    expect(storage.artifacts.versions(id)[2].label).toBe("Preferred spelling");
    await expect(
      command("publish", [id, "--dir", "missing", "--label", "a", "--version-label", "b"]),
    ).rejects.toThrow("not both");
    await expect(
      command("create", ["--kind", "diff", "--stdin-diff", "--version-label", "-"]),
    ).rejects.toThrow("cannot both read stdin");
    expect(stdinReads).toBe(1);
    expect(storage.artifacts.versions(id)).toHaveLength(3);
  });
  test("publisher remotes group new artifacts, backfill existing projects, and never regroup revisions", async () => {
    for (const args of [
      ["init", "-b", "main"],
      ["remote", "add", "origin", "git@code.example:team/repo.git"],
    ])
      expect((await publisherGit(ctx.cwd, args)).code).toBe(0);
    const existing = storage.artifacts.createProject({ name: "Existing" });
    await command("project", ["edit", existing.id, "--remote", "https://code.example/team/repo"]);
    const result = JSON.parse(
      (await command("create", ["--kind", "files", "--dir", ".", "--file", "index.html", "--json"]))
        .text,
    );
    expect(result.artifact.projectId).toBe(existing.id);
    expect(result.version.provenance.remoteUrl).toBe("ssh://code.example/team/repo.git");
    expect(
      (
        await publisherGit(ctx.cwd, [
          "remote",
          "set-url",
          "origin",
          "https://code.example/fork/repo",
        ])
      ).code,
    ).toBe(0);
    await command("publish", [result.artifact.id, "--dir", ".", "--file", "index.html"]);
    expect(storage.artifacts.get(result.artifact.id).projectId).toBe(existing.id);
    expect(storage.artifacts.projects()).toHaveLength(1);
    expect(storage.artifacts.versions(result.artifact.id)[1].provenance.remoteUrl).toBe(
      "https://code.example/fork/repo",
    );
  });
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
    expect(connected).toEqual({ role: "agent", sessionId: "codex:codex-target" });
    await command("listen", [id, "--session", "logical-subagent"]);
    expect(connected).toEqual({ role: "agent", sessionId: "codex:codex-target" });
    expect(
      storage.artifacts.sessions().find((session) => session.id === "codex:codex-target")?.label,
    ).toBe("logical-subagent");
    ctx.environment.R3_AGENT_SESSION = "logical-subagent";
    await command("listen", [id]);
    expect(connected).toEqual({ role: "agent", sessionId: "logical-subagent" });
  });
  test("watch needs no caller identity and publication survives automatic listener failure", async () => {
    const id = await create();
    ctx.environment = {};
    expect((await command("watch", [id, "--timeout", "0.002"])).code).toBe(2);
    ctx.environment = { R3_AGENT_SESSION: agent.sessionId };
    ctx.registerListener = async () => {
      throw new Error("Adapter unavailable");
    };
    expect((await command("publish", [id, "--dir", ".", "--session", "Readable name"])).code).toBe(
      0,
    );
    expect(storage.artifacts.versions(id)).toHaveLength(2);
    expect(storage.artifacts.sessions().find((item) => item.id === agent.sessionId)?.label).toBe(
      "Readable name",
    );
    expect(errors.join("\n")).toContain("Published, but automatic listening");
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
  test("native targets and inherited comment references survive independent agent sessions", async () => {
    const id = await create();
    const threads = JSON.parse(
      (
        await command("thread", [
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
    expect(threads.target.locator).toMatchObject({ selector: "h1", route: "#intro" });
    await command("claim", [threads.id]);
    ctx.environment.R3_AGENT_SESSION = "second-agent";
    await command("comment", [
      threads.id,
      "--session",
      "second-agent",
      "-m",
      "I also inspected it",
    ]);
    expect(storage.conversations.get(threads.id).claim?.sessionId).toBe(agent.sessionId);
    ctx.environment.R3_AGENT_SESSION = agent.sessionId;
    const fix = {
      kind: "rendered" as const,
      versionSeq: 1,
      path: "index.html",
      locator: { selector: "h1", label: "Page heading" },
    };
    const comment = JSON.parse(
      (
        await command("comment", [
          threads.id,
          "-m",
          "Working on the heading",
          "--target",
          JSON.stringify(fix),
          "--version",
          "1",
          "--view",
          "rendered",
        ])
      ).text,
    );
    expect(comment.context).toEqual({ versionSeq: 1, representation: "rendered" });
    expect(comment.target).toEqual(fix);
    expect(storage.conversations.get(threads.id).comments.slice(1).at(-1)?.target).toEqual(fix);
    expect((await command("comment", ["fetch", id, "--all"])).text).toContain(JSON.stringify(fix));
    expect(storage.conversations.get(threads.id).claim).toBeNull();
    expect(storage.conversations.get(threads.id).status).toBe("open");
    await expect(
      command("thread", ["edit", threads.id, "--status", "resolved"]),
    ).rejects.toMatchObject({ status: 400 });
    await command("thread", ["edit", threads.id, "--human", "--status", "resolved"]);
    expect(storage.conversations.get(threads.id).status).toBe("resolved");
  });
  test("history reads and watch exits preserve owner handoff and archive terminal precedence", async () => {
    const id = await create();
    const threads = JSON.parse(
      (await command("thread", ["add", id, "--human", "-m", "Human note"])).text,
    );
    expect((await command("comment", ["fetch", id, "--all"])).text).toContain("Human note");
    expect(storage.conversations.get(threads.id).comments[0]!.sentAt).toBeNull();
    expect((await command("watch", [id])).code).toBe(10);
    expect(storage.conversations.get(threads.id).comments[0]!.sentAt).not.toBeNull();
    expect((await command("watch", [id, "--timeout", "0.01"])).code).toBe(2);
    await command("thread", ["add", id, "--human", "-m", "Still pending"]);
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
  test("comment fetch preserves selective delivery and resolved history semantics", async () => {
    const id = await create();
    const first = JSON.parse(
      (await command("thread", ["add", id, "--human", "-m", "First note"])).text,
    );
    const second = JSON.parse(
      (await command("thread", ["add", id, "--human", "-m", "Second note"])).text,
    );
    expect((await command("comment", ["fetch", id, "--all"])).text).toContain("First note");
    expect(storage.conversations.unsent(id)).toHaveLength(2);
    const selected = await command("comment", ["fetch", id, "--threads", first.id]);
    expect(selected.text).toContain("First note");
    expect(selected.text).not.toContain("Second note");
    expect(storage.conversations.get(first.id).comments[0]!.sentAt).not.toBeNull();
    expect(storage.conversations.get(second.id).comments[0]!.sentAt).toBeNull();
    await command("thread", ["edit", first.id, "--human", "--status", "resolved"]);
    const history = await command("comment", ["fetch", id, "--all", "--threads", first.id]);
    expect(history.text).toContain("[resolved]");
    expect(history.text).toContain("First note");
    expect(storage.conversations.get(first.id).statusUnsent).toBe(true);
    expect((await command("comment", ["fetch", id, "--all"])).text).not.toContain("First note");
    await expect(command("comment", ["fetch", id, "extra"])).rejects.toThrow("expects 1");
    expect(storage.conversations.unsent(id)).toHaveLength(2);
    expect((await command("comment", ["fetch", id])).text).toContain(
      "The human marked this resolved",
    );
    expect(storage.conversations.unsent(id)).toHaveLength(0);
  });
  test("comment fetch drains new notes and comments and registers the calling harness quietly", async () => {
    const id = await create();
    const first = JSON.parse(
      (await command("thread", ["add", id, "--human", "-m", "First note"])).text,
    );
    await command("comment", ["fetch", id]);
    await command("comment", [first.id, "--human", "-m", "New comment"]);
    await command("thread", ["add", id, "--human", "-m", "New note"]);
    ctx.environment = { CODEX_THREAD_ID: "fetch-agent" };
    const registrations: unknown[] = [];
    ctx.listen = async (artifactId, actor, foreground, quiet) => {
      registrations.push({ artifactId, actor, foreground, quiet });
      storage.listeners.setTarget(actor.sessionId!, { harness: "codex", threadId: "fetch-agent" });
      storage.listeners.register(artifactId, actor, "explicit");
      return 0;
    };
    const fetched = await command("comment", ["fetch", id, "--session", "Review assistant"]);
    expect(fetched.code).toBe(0);
    expect(fetched.text).toContain("New comment");
    expect(fetched.text).toContain("New note");
    expect(fetched.text).not.toContain("Listening on");
    expect(storage.conversations.unsent(id)).toHaveLength(0);
    expect(registrations).toEqual([
      {
        artifactId: id,
        actor: { role: "agent", sessionId: "codex:fetch-agent" },
        foreground: false,
        quiet: true,
      },
    ]);
    expect(storage.listeners.selected(id)?.info).toMatchObject({
      mode: "explicit",
      label: "Review assistant",
      actor: { sessionId: "codex:fetch-agent" },
    });
    const empty = await command("comment", ["fetch", id]);
    expect(empty.text).not.toContain("New comment");
    expect(empty.text).not.toContain("New note");
    expect(registrations).toHaveLength(2);
  });
  test("threads history, human reads, and unsupported harnesses leave listeners alone", async () => {
    const id = await create();
    await command("thread", ["add", id, "--human", "-m", "Pending note"]);
    let registrations = 0;
    ctx.listen = async () => {
      registrations++;
      return 0;
    };
    ctx.environment = { CODEX_THREAD_ID: "fetch-agent" };
    await command("comment", ["fetch", id, "--all"]);
    expect(storage.conversations.unsent(id)).toHaveLength(1);
    await command("comment", ["fetch", id, "--human"]);
    ctx.environment = {};
    expect((await command("comment", ["fetch", id])).code).toBe(0);
    expect(registrations).toBe(0);
    expect(errors).toEqual([]);
  });
  test("automatic listen failures preserve fetched threads, but failed fetches never register", async () => {
    const id = await create();
    await command("thread", ["add", id, "--human", "-m", "Pending note"]);
    ctx.environment = { CODEX_THREAD_ID: "fetch-agent", R3_AGENT_SESSION: "logical-agent" };
    let registrations = 0;
    ctx.listen = async (_id, actor) => {
      expect(actor.sessionId).toBe("logical-agent");
      registrations++;
      throw new Error("Adapter unavailable");
    };
    const fetched = await command("comment", ["fetch", id]);
    expect(fetched.code).toBe(0);
    expect(fetched.text).toContain("Pending note");
    expect(storage.conversations.unsent(id)).toHaveLength(0);
    expect(errors).toEqual([
      "Comments fetched, but automatic listening could not be configured. Run r3 listen or use r3 watch.",
    ]);
    await command("archive", [id, "--human"]);
    await expect(command("comment", ["fetch", id])).rejects.toThrow();
    expect(registrations).toBe(1);
  });
  test("invalid capture and target flags fail before changing artifact state", async () => {
    await expect(
      command("create", ["--kind", "files", "--dir", ".", "--stdin-diff"]),
    ).rejects.toThrow("exactly one");
    await expect(
      command("create", ["--kind", "files", "--dir", ".", "--entrypoint", "index.html"]),
    ).rejects.toThrow("Unknown option");
    expect(storage.artifacts.list()).toEqual([]);
    await expect(
      command("comment", ["thread_missing", "-m", "test", "--file", "index.html"]),
    ).rejects.toThrow("--view is required");
    ctx.environment = {};
    await expect(command("create", ["--dir", "."])).rejects.toThrow("stable agent ID");
    expect(storage.artifacts.list()).toEqual([]);
  });
  test("Markdown-only HTML publications fail without changing artifacts or versions", async () => {
    const id = await create();
    await writeFile(join(ctx.cwd, "index.md"), "# Another index\n");
    await rm(join(ctx.cwd, "index.html"));
    await expect(command("create", ["--kind", "html", "--dir", "."])).rejects.toThrow(
      "root index.html",
    );
    await expect(command("publish", [id, "--dir", "."])).rejects.toThrow("root index.html");
    expect(storage.artifacts.list()).toHaveLength(1);
    expect(storage.artifacts.versions(id)).toHaveLength(1);
    expect((await command("download", [id, "--version", "1", "--file", "index.html"])).text).toBe(
      "<h1>First</h1>\n",
    );
    await writeFile(join(ctx.cwd, "index.html"), '<a href="index.md">Notes</a>\n');
    await command("publish", [id, "--dir", "."]);
    expect(storage.artifacts.version(id, 2).entrypoint).toBe("index.html");
    expect(storage.artifacts.file(id, 2, "index.md").renderedHash).not.toBeNull();
  });
  test("stdin patches become independent published versions without any git checkout", async () => {
    const patch =
      "diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-before\n+after\n";
    ctx.stdin = async () => patch;
    const result = JSON.parse(
      (await command("create", ["--kind", "diff", "--stdin-diff", "--json"])).text,
    );
    expect(result.artifact.kind).toBe("diff");
    expect((await command("patch", [result.artifact.id, "--version", "1"])).text).toBe(patch);
    const threads = JSON.parse(
      (
        await command("thread", [
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
    expect(threads.target.locator.side).toBe("old");
  });
});
test("search exposes pinned publication matches and pagination without an agent identity", async () => {
  const id = await create();
  ctx.environment = {};
  const result = JSON.parse(
    (
      await command("search", [
        "First",
        "--json",
        "--type",
        "content",
        "--history",
        "all",
        "--limit",
        "1",
      ])
    ).text,
  );
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({
    artifactId: id,
    category: "content",
    versionSeq: 1,
    path: "index.html",
  });
  expect(result.matches[0].target.kind).toBe("rendered");
  const text = (await command("search", ["First"])).text;
  expect(text).toContain("1 matches");
  expect(text).toContain("v1");
  await expect(command("search", ["First", "--limit", "1000"])).rejects.toThrow();
});
test("stat and gc expose fixed windows, JSON and validated day overrides without agent identity", async () => {
  ctx.environment = {};
  const daily = await command("stat", ["--json"]);
  expect(JSON.parse(daily.text)).toMatchObject({ window: "daily", artifacts: { total: 0 } });
  expect(JSON.parse(daily.text).periods).toHaveLength(14);
  const weekly = await command("stat", ["--weekly"]);
  expect(weekly.text).toContain("Last 4 weeks");
  expect(weekly.text).toContain("Content:");
  const gc = await command("gc", ["--dry-run", "--ttl", "7d", "--json"]);
  expect(JSON.parse(gc.text)).toMatchObject({ dryRun: true, ttlDays: 7, candidates: [] });
  expect((await command("gc", [])).code).toBe(0);
  for (const value of ["0d", "-1d", "1.5d", "7", "36501d"])
    await expect(command("gc", ["--ttl", value])).rejects.toThrow();
  await expect(command("stat", ["extra"])).rejects.toThrow();
  await expect(command("stat", ["--ttl", "1d"])).rejects.toThrow();
});
