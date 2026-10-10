import { dirname, resolve } from "node:path";
import {
  type DaemonInfo,
  forceReleaseDaemonLock,
  isPidAlive,
  R3_VERSION,
  readDaemonJson,
  readDaemonLockOwner,
  removeDaemonJson,
} from "../server/config.ts";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { BackendCredentials, selectedBackend } from "./backend.ts";
import { localBootstrap } from "./local-bootstrap.ts";

interface Health {
  ok: boolean;
  version: string;
  protocol?: string;
}
const sleep = (milliseconds: number) => Bun.sleep(milliseconds);
export const compiledCli = () => Bun.embeddedFiles.length > 0;
export const cliProcessArgv = (command: string, ...args: string[]) =>
  compiledCli()
    ? [process.execPath, command, ...args]
    : [process.execPath, resolve(import.meta.dir, "index.ts"), command, ...args];

async function probe(url: string): Promise<Health | null> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const health = (await response.json()) as Health;
    return health.ok === true && typeof health.version === "string" ? health : null;
  } catch {
    return null;
  }
}

function daemonProcess(pid: number, info?: DaemonInfo): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    })
      .stdout.toString()
      .trim();
    if (!command) return false;
    if (command.includes("__daemon")) return true;
    const distinctive = info?.argv?.filter((value) => !/(?:^|\/)(?:bun|node)$/.test(value));
    return !!distinctive?.length && distinctive.every((value) => command.includes(value));
  } catch {
    return false;
  }
}

async function stopProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 60 && isPidAlive(pid); attempt++) await sleep(50);
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* The daemon may already have exited. */
    }
    for (let attempt = 0; attempt < 40 && isPidAlive(pid); attempt++) await sleep(50);
  }
  if (isPidAlive(pid))
    throw new ArtifactCommandError("The daemon could not be stopped; its start lock was retained");
  if (readDaemonLockOwner() === pid) forceReleaseDaemonLock();
  if (readDaemonJson()?.pid === pid) removeDaemonJson();
}

async function spawnDaemon(): Promise<DaemonInfo> {
  const child = Bun.spawn(cliProcessArgv("__daemon"), {
    cwd: compiledCli() ? process.cwd() : resolve(dirname(Bun.main), ".."),
    env: { ...process.env, R3_DETACHED: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  // Initial migration and source bundling can take longer than the former
  // five-second live-review bootstrap. Poll actual health, never assume ready.
  const deadline = Date.now() + 180_000;
  let exitedAt: number | null = null;
  while (Date.now() < deadline) {
    await sleep(100);
    const info = readDaemonJson();
    if (info && (await probe(info.url))) return info;
    if (child.exitCode !== null) {
      exitedAt ??= Date.now();
      if (Date.now() - exitedAt > 2000 && !isPidAlive(readDaemonLockOwner() ?? 0)) break;
    }
  }
  throw new ArtifactCommandError(
    "Daemon did not become ready. Run r3 __daemon in a terminal to see the startup error; check the state directory and migration backup if migration failed.",
  );
}

export interface ArtifactServerLocation {
  getToken?: () => Promise<string>;
  url: string;
  token: string;
  publicUrl: string;
}
export async function discoverArtifactServer(forLogin = false): Promise<ArtifactServerLocation> {
  const selected = selectedBackend();
  const credentials = new BackendCredentials();
  if (selected) {
    if (!forLogin) await credentials.token(selected);
    return {
      url: selected,
      token: "",
      publicUrl: selected,
      getToken: () => credentials.token(selected),
    };
  }
  let info = readDaemonJson();
  let health = info ? await probe(info.url) : null;
  if (!info || !health) {
    info = await spawnDaemon();
    health = await probe(info.url);
  }
  if (health?.protocol !== "artifacts-v3")
    throw new ArtifactCommandError(
      "The running daemon uses the previous review protocol. Run r3 server restart to migrate it before using artifact commands.",
    );
  if (health.version !== R3_VERSION)
    process.stderr.write(
      `r3: daemon is v${health.version}; this CLI is v${R3_VERSION}. Run r3 server restart to use this build.\n`,
    );
  const url = normalizeBackendUrl(info.url);
  if (!info.bootstrapSocket)
    throw new ArtifactCommandError("Restart the local server to enable private local setup");
  const local = await localBootstrap<{ url: string; token: string; publicUrl: string }>(
    info.bootstrapSocket,
    "bootstrap",
  );
  if (normalizeBackendUrl(local.url) !== url || typeof local.token !== "string" || !local.token)
    throw new ArtifactCommandError("Invalid local bootstrap response");
  const current = credentials.read(url);
  if (!current || current.kind !== "key" || current.accessToken !== local.token)
    await credentials.save({ url, kind: "key", accessToken: local.token });
  return {
    url,
    token: local.token,
    getToken: () => credentials.token(url),
    publicUrl: local.publicUrl,
  };
}

export async function daemonCommand(
  command: "start" | "stop" | "status" | "restart",
): Promise<void> {
  if (command === "restart") {
    await daemonCommand("stop");
    await daemonCommand("start");
    return;
  }
  const info = readDaemonJson();
  if (command === "status") {
    if (!info) {
      console.log("r3: no daemon announced");
      return;
    }
    const health = await probe(info.url);
    console.log(
      health
        ? `r3 daemon: ${info.publicUrl ?? info.url} · v${health.version} · ${health.protocol ?? "previous review protocol"}`
        : "r3: announced daemon is not responding",
    );
    console.log(
      info.bootstrapSocket
        ? "browser access: r3 open or a login token"
        : `login ${info.requireLogin ? "required" : "not required"}`,
    );
    return;
  }
  if (command === "start") {
    if (info && (await probe(info.url))) {
      console.log(`r3 daemon already running: ${info.publicUrl ?? info.url}`);
      return;
    }
    const started = await spawnDaemon();
    console.log(`r3 daemon started: ${started.publicUrl ?? started.url}`);
    return;
  }
  const pid = info?.pid ?? readDaemonLockOwner();
  if (pid && daemonProcess(pid, info ?? undefined)) {
    await stopProcess(pid);
    console.log("r3 daemon stopped");
  } else {
    if (pid && readDaemonJson()?.pid === pid) removeDaemonJson();
    if (pid && readDaemonLockOwner() === pid) forceReleaseDaemonLock();
    console.log("r3: no live daemon");
  }
}
