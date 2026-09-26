import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("artifact CLI lazily starts an isolated daemon and completes publication and conversation lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-cli-runtime-"));
  const directory = join(root, "publication");
  await mkdir(directory);
  await writeFile(join(directory, "page.md"), "# Before\n");
  await writeFile(join(directory, "data.bin"), new Uint8Array([0, 128, 255]));
  const bin = join(root, "bin");
  const queueFile = join(root, "queued.json");
  await mkdir(bin);
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env bun
if (process.argv[2] !== "queue") process.exit(1);
await Bun.write(process.env.R3_TEST_QUEUE_FILE, JSON.stringify({
  argv: process.argv.slice(2), home: process.env.CODEX_HOME,
}));
`,
  );
  await chmod(join(bin, "codex"), 0o700);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const previewReservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const environment = {
    ...process.env,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    R3_DB: join(root, "store.sqlite"),
    R3_PORT: String(reservation.port),
    R3_PREVIEW_PORT: String(previewReservation.port),
    R3_BIND: "127.0.0.1",
    R3_PUBLIC_URL: "",
    R3_PREVIEW_BASE_URL: "",
    R3_ALLOWED_HOSTS: "",
    R3_REQUIRE_LOGIN: "0",
    R3_URL: "",
    R3_TOKEN: "",
    R3_AGENT_SESSION: "cli-runtime-publisher",
    R3_DEV: "0",
    PATH: `${bin}:${process.env.PATH}`,
    CODEX_HOME: join(root, "codex-home"),
    CODEX_THREAD_ID: "publisher-thread",
    CODEX_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_CODE_MESSAGING_SOCKET: "",
    CLAUDE_CODE_MESSAGING_TOKEN: "",
    R3_TEST_QUEUE_FILE: queueFile,
  };
  await reservation.stop(true);
  await previewReservation.stop(true);
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      cwd: directory,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { output, error, code };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const help = (await run("help")).output;
    expect(help).toContain("published artifacts");
    expect(help).not.toContain("prompt <id>");
    const removed = await run("prompt", "artifact_missing");
    expect(removed.code).toBe(1);
    expect(removed.error).toContain("Unknown command: prompt");
    for (const [args, heading] of [
      [[], "# r3 — publish artifacts and respond to feedback"],
      [["html"], "# HTML artifacts"],
      [["files"], "# Files artifacts"],
      [["diff"], "# Diff artifacts"],
    ] as const) {
      const guide = await run("guide", ...args);
      expect(guide.code).toBe(0);
      expect(guide.error).toBe("");
      expect(guide.output.startsWith(heading)).toBe(true);
      expect(guide.output).not.toContain("auth create-token");
    }
    for (const args of [["unknown"], ["constructor"], ["html", "files"]]) {
      const invalid = await run("guide", ...args);
      expect(invalid.code).toBe(1);
      expect(invalid.output).toBe("");
      expect(invalid.error).toContain("guide");
    }
    expect(await Bun.file(join(root, "store.sqlite")).exists()).toBe(false);
    const created = await run(
      "create",
      "--kind",
      "files",
      "--dir",
      directory,
      "--title",
      "CLI publication",
      "--session",
      "Friendly publisher",
      "--json",
    );
    expect(created.error).toBe("");
    expect(created.code).toBe(0);
    const first = JSON.parse(created.output);
    const id = first.artifact.id as string;
    expect(first.version.seq).toBe(1);
    const daemonInfo = () => Bun.file(join(root, "runtime", "r3", "daemon.json")).json();
    const request = async (path: string, method = "GET") => {
      const daemon = await daemonInfo();
      const result = await fetch(`${daemon.url}/api/${path}`, {
        method,
        headers: { "x-r3-token": daemon.token },
      });
      expect(result.ok).toBe(true);
      return result.json();
    };
    const watchers = () => request(`artifacts/${id}/watchers`);
    expect(await watchers()).toMatchObject([
      {
        mode: "fallback",
        label: "Friendly publisher",
        actor: { role: "agent", sessionId: "cli-runtime-publisher" },
      },
    ]);
    expect(await Bun.file(queueFile).exists()).toBe(false);
    expect(await request(`artifacts/${id}/submit`, "POST")).toEqual({
      notification: { state: "queued" },
    });
    const queued = await Bun.file(queueFile).json();
    expect(queued.argv.slice(0, 3)).toEqual(["queue", "--thread", "publisher-thread"]);
    expect(queued.home).toBe(environment.CODEX_HOME);
    await rm(queueFile);
    const daemonPid = (await daemonInfo()).pid;
    expect((await run("listen", id)).code).toBe(0);
    expect((await daemonInfo()).pid).toBe(daemonPid);
    expect(await watchers()).toMatchObject([{ mode: "explicit" }]);
    expect((await run("unlisten", id)).code).toBe(0);
    expect(await watchers()).toEqual([]);
    const fetched = await run("feedback", "fetch", id);
    expect(fetched.code).toBe(0);
    expect(fetched.error).toBe("");
    expect(fetched.output).not.toContain("Listening on");
    expect(await watchers()).toMatchObject([
      { mode: "explicit", actor: { sessionId: "cli-runtime-publisher" } },
    ]);
    expect((await daemonInfo()).pid).toBe(daemonPid);
    expect(await Bun.file(queueFile).exists()).toBe(false);
    expect((await run("unlisten", id)).code).toBe(0);
    expect((await run("feedback", "fetch", id, "--all")).code).toBe(0);
    expect(await watchers()).toEqual([]);
    expect((await run("status")).output).toContain("artifacts-v1");
    await writeFile(join(directory, "page.md"), "# After\n");
    expect(
      JSON.parse((await run("source", id, "--version", "1", "--file", "page.md", "--json")).output)
        .lines[0].text,
    ).toBe("# Before");
    const published = await run(
      "publish",
      id,
      "--dir",
      directory,
      "--expected",
      "1",
      "--key",
      "second",
      "--json",
    );
    expect(published.code).toBe(0);
    expect(JSON.parse(published.output).version.seq).toBe(2);
    expect((await run("restart")).code).toBe(0);
    expect(await watchers()).toMatchObject([{ mode: "fallback", label: "Friendly publisher" }]);
    expect(await Bun.file(queueFile).exists()).toBe(false);
    const note = await run(
      "feedback",
      "add",
      id,
      "--human",
      "-m",
      "Please explain the change",
      "--file",
      "page.md",
      "--version",
      "1",
      "--view",
      "source",
      "--line",
      "1",
      "--quote",
      "# Before",
    );
    expect(note.code).toBe(0);
    const feedback = JSON.parse(note.output);
    const watch = await run("watch", id, "--timeout", "1");
    expect(watch.code).toBe(10);
    expect(watch.output).toContain(feedback.id);
    expect((await run("claim", feedback.id)).code).toBe(0);
    expect(
      (
        await run(
          "reply",
          feedback.id,
          "-m",
          "Updated in version two",
          "--version",
          "2",
          "--view",
          "source",
        )
      ).code,
    ).toBe(0);
    const detail = JSON.parse((await run("show", id, "--json")).output);
    expect(detail.feedback[0].status).toBe("open");
    expect(detail.feedback[0].claim).toBeNull();
    expect(detail.feedback[0].replies[0].context).toEqual({
      versionSeq: 2,
      representation: "source",
    });
    expect(
      (await run("archive", id, "--human", "--key", "archive-once", "-m", "Keep this history"))
        .code,
    ).toBe(0);
    const archived = await run("watch", id, "--timeout", "0.001");
    expect(archived.code).toBe(0);
    expect(archived.output).toContain("Keep this history");
    expect((await run("publish", id, "--dir", directory)).code).toBe(4);
    expect((await run("restore", id, "--human", "--key", "restore-once")).code).toBe(0);
    expect((await run("config", "set", "previewPort", environment.R3_PREVIEW_PORT)).code).toBe(0);
    expect((await run("config", "get", "previewPort")).output.trim()).toBe(
      environment.R3_PREVIEW_PORT,
    );
  } finally {
    const stopped = await run("stop");
    expect(stopped.code).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
