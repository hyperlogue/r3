import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBootstrap } from "./local-bootstrap.ts";

async function readPublicationInFreshBrowser(link: string, artifactId: string) {
  const url = new URL(link);
  expect(url.pathname).toBe(`/${artifactId}`);
  expect(url.hash).toBe("");
  const boot = await fetch(`${url.origin}/api/boot`);
  expect(boot.status).toBe(200);
  expect(await boot.json()).toEqual({ needsAuth: false, token: null, loginRequired: false });
  expect(boot.headers.get("set-cookie")).toBeNull();
  const read = await fetch(`${url.origin}/api/artifacts/${artifactId}`);
  expect(read.status).toBe(200);
  expect((await read.json()).id).toBe(artifactId);
}

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
  const environment = {
    ...process.env,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    R3_DB: join(root, "store.sqlite"),
    R3_PORT: String(reservation.port),
    R3_BIND: "127.0.0.1",
    R3_PUBLIC_URL: "",
    R3_ALLOWED_HOSTS: "",
    R3_REQUIRE_LOGIN: "",
    R3_URL: "",
    R3_TOKEN: "",
    R3_AGENT_SESSION: "cli-runtime-publisher",
    R3_DEV: "0",
    PATH: `${bin}:${process.env.PATH}`,
    CODEX_HOME: join(root, "codex-home"),
    CODEX_THREAD_ID: "publisher-thread",
    CODEX_SESSION_ID: "",
    CODEX_PERMISSION_PROFILE: "workspace-write",
    CODEX_SANDBOX: "",
    CODEX_SANDBOX_NETWORK_DISABLED: "0",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_CODE_MESSAGING_SOCKET: "",
    CLAUDE_CODE_MESSAGING_TOKEN: "",
    R3_TEST_QUEUE_FILE: queueFile,
  };
  await reservation.stop(true);
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
      [[], "# r3 — publish artifacts and respond to threads"],
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
    const legacyImport = join(environment.XDG_STATE_HOME, "r3", "worker-import.json");
    await mkdir(join(environment.XDG_STATE_HOME, "r3"), { recursive: true });
    await writeFile(legacyImport, "invalid obsolete import");
    const listed = await run("list", "--json");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.output)).toEqual([]);
    expect(await Bun.file(legacyImport).exists()).toBe(false);
    expect(await Bun.file(join(root, "runtime", "r3", "worker.json")).exists()).toBe(false);
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
    expect(created.error).toContain("sandbox environment detected while starting the r3 worker");
    expect(created.code).toBe(0);
    const first = JSON.parse(created.output);
    const id = first.artifact.id as string;
    expect(first.version.seq).toBe(1);
    await readPublicationInFreshBrowser(first.url, id);
    expect((await run("open", id)).output.trim()).toBe(first.url);
    expect(await (await fetch(`${new URL(first.url).origin}/api/auth/tokens`)).json()).toEqual([]);
    const daemonInfo = () => Bun.file(join(root, "runtime", "r3", "daemon.json")).json();
    const request = async (path: string, method = "GET") => {
      const daemon = await daemonInfo();
      const { token } = await localBootstrap<{ token: string }>(
        daemon.bootstrapSocket,
        "bootstrap",
      );
      const result = await fetch(`${daemon.url}/api/${path}`, {
        method,
        headers: { "x-r3-token": token },
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
    const fetched = await run("comment", "fetch", id);
    expect(fetched.code).toBe(0);
    expect(fetched.error).toBe("");
    expect(fetched.output).not.toContain("Listening on");
    expect(await watchers()).toMatchObject([
      { mode: "explicit", actor: { sessionId: "cli-runtime-publisher" } },
    ]);
    expect((await daemonInfo()).pid).toBe(daemonPid);
    expect(await Bun.file(queueFile).exists()).toBe(false);
    expect((await run("unlisten", id)).code).toBe(0);
    expect((await run("comment", "fetch", id, "--all")).code).toBe(0);
    expect(await watchers()).toEqual([]);
    expect((await run("status")).output).toContain("artifacts-v3");
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
    expect(JSON.parse(published.output).url).toBe(first.url);
    await readPublicationInFreshBrowser(JSON.parse(published.output).url, id);
    const plain = await run("create", "--kind", "files", "--dir", directory, "--no-listen");
    expect(plain.code).toBe(0);
    const plainUrl = plain.output.split("\n").find((line) => line.startsWith("http"))!;
    await readPublicationInFreshBrowser(plainUrl, new URL(plainUrl).pathname.slice(1));
    // An explicitly selected backend never inherits automatic-local browser grants.
    environment.R3_URL = new URL(first.url).origin;
    try {
      await rm(join(environment.XDG_CONFIG_HOME, "r3", "credentials"), { recursive: true });
      const selected = await run(
        "create",
        "--kind",
        "files",
        "--dir",
        directory,
        "--no-listen",
        "--json",
      );
      expect(selected.code).toBe(0);
      expect(new URL(JSON.parse(selected.output).url).hash).toBe("");
    } finally {
      environment.R3_URL = "";
    }
    expect((await run("restart")).code).toBe(0);
    const reconnectDeadline = Date.now() + 5000;
    while (
      !(await watchers()).some(
        (watcher: { connectionState?: string }) => watcher.connectionState === "connected",
      ) &&
      Date.now() < reconnectDeadline
    )
      await Bun.sleep(50);
    expect(await watchers()).toMatchObject([
      { mode: "fallback", label: "Friendly publisher", connectionState: "connected" },
    ]);
    expect(await Bun.file(queueFile).exists()).toBe(false);
    const note = await run(
      "thread",
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
    const threads = JSON.parse(note.output);
    const watch = await run("watch", id, "--timeout", "1");
    expect(watch.code).toBe(10);
    expect(watch.output).toContain(threads.id);
    expect((await run("claim", threads.id)).code).toBe(0);
    const commentResult = await run(
      "comment",
      threads.id,
      "-m",
      "Updated in version two",
      "--file",
      "page.md",
      "--version",
      "2",
      "--view",
      "source",
    );
    expect(commentResult).toMatchObject({ code: 0, error: "" });
    const detail = JSON.parse((await run("show", id, "--json")).output);
    expect(detail.threads[0].status).toBe("open");
    expect(detail.threads[0].claim).toBeNull();
    expect(detail.threads[0].comments[1].context).toEqual({
      versionSeq: 2,
      representation: "source",
    });
    const archiveResult = await run(
      "archive",
      id,
      "--human",
      "--key",
      "archive-once",
      "-m",
      "Keep this history",
    );
    expect(archiveResult).toMatchObject({
      code: 0,
      error: "",
    });
    const archived = await run("watch", id, "--timeout", "0.001");
    expect(archived.code).toBe(0);
    expect(archived.output).toContain("Keep this history");
    expect((await run("publish", id, "--dir", directory)).code).toBe(4);
    const archiveComment = JSON.parse(archiveResult.output).event.comment;
    expect((await run("comment", "show", archiveComment.id)).output.trim()).toBe(
      "Keep this history",
    );
    expect(
      (await run("comment", "edit", archiveComment.id, "--human", "-m", "Cannot edit yet")).code,
    ).toBe(4);
    expect((await run("restore", id, "--human", "--key", "restore-once")).code).toBe(0);
    expect(
      (await run("comment", "edit", archiveComment.id, "--human", "-m", "Updated archive comment"))
        .code,
    ).toBe(0);
    const archiveHandoff = await run("comment", "fetch", id, "--human");
    expect(archiveHandoff.code).toBe(0);
    expect(archiveHandoff.output).toContain("Updated archive comment");
    const updatedHistory = JSON.parse((await run("show", id, "--json")).output);
    expect(updatedHistory.events[0].comment.sentAt).not.toBeNull();
    expect((await run("config", "set", "port", environment.R3_PORT)).code).toBe(0);
    expect((await run("config", "get", "port")).output.trim()).toBe(environment.R3_PORT);
  } finally {
    await run("worker", "stop");
    const stopped = await run("stop");
    expect(stopped.code).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("r3 open creates a login token only when signed out and refuses exposure without login", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-cli-protected-"));
  const directory = join(root, "publication");
  await mkdir(directory);
  await writeFile(join(directory, "page.md"), "# Protected\n");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const environment: Record<string, string | undefined> = {
    ...process.env,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    R3_DB: join(root, "store.sqlite"),
    R3_PORT: String(reservation.port),
    R3_BIND: "127.0.0.1",
    R3_PUBLIC_URL: "",
    R3_ALLOWED_HOSTS: "",
    R3_REQUIRE_LOGIN: "true",
    R3_URL: "",
    R3_TOKEN: "",
    R3_AGENT_SESSION: "cli-protected-publisher",
    R3_DEV: "0",
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_CODE_MESSAGING_SOCKET: "",
    CLAUDE_CODE_MESSAGING_TOKEN: "",
  };
  await reservation.stop(true);
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
    const created = await run(
      "create",
      "--kind",
      "files",
      "--dir",
      directory,
      "--no-listen",
      "--json",
    );
    expect(created.code).toBe(0);
    const { url: link, artifact } = JSON.parse(created.output);
    const origin = new URL(link).origin;
    // Stable links carry no grant; a fresh browser must sign in before reading.
    expect(new URL(link).hash).toBe("");
    const boot = await fetch(`${origin}/api/boot`);
    expect(boot.status).toBe(401);
    expect(await boot.json()).toEqual({ needsAuth: true, token: null, loginRequired: true });
    expect((await fetch(`${origin}/api/artifacts/${artifact.id}`)).status).toBe(401);

    let browserCookie = "";
    const exchange = (url: string, cookie = "") =>
      fetch(`${origin}/api/auth/local`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ ticket: new URL(url).hash.slice("#r3-login=".length) }),
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      const opened = await run("open", artifact.id);
      expect(opened.code).toBe(0);
      expect(new URL(opened.output.trim()).pathname).toBe(`/${artifact.id}`);
      expect(new URL(opened.output.trim()).hash.startsWith("#r3-login=")).toBe(true);
      expect((await fetch(opened.output.trim())).headers.get("set-cookie")).toBeNull();
      const signedIn = await exchange(opened.output.trim(), browserCookie);
      expect(signedIn.status).toBe(200);
      if (attempt === 0) browserCookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
      else expect(signedIn.headers.get("set-cookie")).toBeNull();
      expect(
        (await fetch(`${origin}/api/boot`, { headers: { cookie: browserCookie } })).status,
      ).toBe(200);
    }
    expect(JSON.parse((await run("auth", "list-tokens", "--json")).output)).toHaveLength(1);
    expect((await fetch(`${origin}/api/boot`)).status).toBe(401);

    // Browser sign-in remains explicit; opening URLs leaves that session intact.
    const login = await run("auth", "create-token", "--label", "Browser");
    expect(login.code).toBe(0);
    const signedIn = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: login.output.trim() }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    const read = await fetch(`${origin}/api/artifacts/${artifact.id}`, { headers: { cookie } });
    expect(read.status).toBe(200);
    const reopened = await run("open", artifact.id);
    const reused = await exchange(reopened.output.trim(), cookie);
    expect(reused.status).toBe(200);
    expect(reused.headers.get("set-cookie")).toBeNull();
    expect((await fetch(reopened.output.trim(), { headers: { cookie } })).status).toBe(200);
    expect(JSON.parse((await run("auth", "list-tokens", "--json")).output)).toHaveLength(2);

    // An explicitly selected backend never inherits automatic-local credentials.
    environment.R3_URL = origin;
    try {
      await rm(join(root, "config", "r3", "credentials"), { recursive: true, force: true });
      const selected = await run("create", "--kind", "files", "--dir", directory, "--no-listen");
      expect(selected.code).not.toBe(0);
      expect(selected.error).toContain("run r3 login");
    } finally {
      environment.R3_URL = "";
    }
    expect((await run("stop")).code).toBe(0);

    // Exposure with login turned off refuses to start, whichever way it starts.
    environment.R3_REQUIRE_LOGIN = "false";
    environment.R3_PUBLIC_URL = "https://reviews.example";
    for (const args of [["server", "start"], ["list"], ["__daemon"]]) {
      const refused = await run(...args);
      expect({ args, code: refused.code === 0 }).toEqual({ args, code: false });
      expect(refused.error).toContain("requireLogin=false is allowed only");
    }
    expect(await Bun.file(join(root, "runtime", "r3", "daemon.json")).exists()).toBe(false);
  } finally {
    environment.R3_REQUIRE_LOGIN = "true";
    environment.R3_PUBLIC_URL = "";
    await run("stop");
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
