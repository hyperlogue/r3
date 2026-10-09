import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactApiError, ArtifactClient } from "../shared/artifact-client.ts";
import type { ArtifactActor } from "../shared/artifacts.ts";
import { R3_VERSION } from "../shared/version.ts";
import type { WorkerSubscription } from "../shared/worker-protocol.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { runArtifactCommand } from "./artifact-commands.ts";
import { ARTIFACT_HELP, artifactGuide, artifactWelcome } from "./artifact-help.ts";
import { writeArtifactOutput } from "./artifact-output.ts";
import { authCommand, configCommand } from "./artifact-settings.ts";
import { daemonCommand, discoverArtifactServer } from "./daemon-client.ts";
import { detectListener } from "./listener.ts";
import { loginCommand } from "./login.ts";
import { ensureWorker, workerCommand } from "./worker-client.ts";

const COMMANDS = new Set([
  "create",
  "publish",
  "list",
  "search",
  "stat",
  "gc",
  "show",
  "versions",
  "files",
  "source",
  "download",
  "patch",
  "edit",
  "delete",
  "feedback",
  "reply",
  "place",
  "claim",
  "release",
  "watch",
  "listen",
  "unlisten",
  "archive",
  "restore",
  "project",
  "auth",
]);

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY)
    throw new ArtifactCommandError("Pipe the requested text or patch to stdin");
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024 * 1024)
        throw new ArtifactCommandError("Stdin exceeds the 16 MiB text limit");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function artifactMain(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    console.log(artifactWelcome());
    return 0;
  }
  if (["help", "--help", "-h"].includes(command)) {
    console.log(ARTIFACT_HELP);
    return 0;
  }
  if (["version", "--version", "-v"].includes(command)) {
    console.log(R3_VERSION);
    return 0;
  }
  if (command === "guide") {
    console.log(artifactGuide(args));
    return 0;
  }
  if (command === "config") {
    configCommand(args);
    return 0;
  }
  if (command === "__daemon") {
    const { startArtifactDaemon } = await import("../server/artifact-daemon.ts");
    await startArtifactDaemon();
    return 0;
  }
  if (command === "__worker") {
    const { startWorker } = await import("./worker-runtime.ts");
    await startWorker();
    process.exit(0);
  }
  if (command === "login") {
    await loginCommand(args);
    return 0;
  }
  if (command === "worker") {
    if (args.length !== 1) throw new ArtifactCommandError("worker start|stop|status|restart");
    await workerCommand(args[0]);
    return 0;
  }
  if (command === "server") {
    if (args.length !== 1 || !["start", "stop", "status", "restart"].includes(args[0]))
      throw new ArtifactCommandError("server start|stop|status|restart");
    await daemonCommand(args[0] as "start" | "stop" | "status" | "restart");
    return 0;
  }
  if (command === "start" || command === "stop" || command === "status" || command === "restart") {
    if (args.length) throw new ArtifactCommandError(`${command} takes no arguments`);
    await daemonCommand(command);
    return 0;
  }
  if (!COMMANDS.has(command))
    throw new ArtifactCommandError(
      `Unknown command: ${command}. Run r3 help for artifact commands.`,
    );
  const location = await discoverArtifactServer();
  const client = new ArtifactClient(location);
  await client.checkProtocol();
  if (command === "auth") {
    await authCommand(client, args);
    return 0;
  }
  let localWorker: ArtifactClient | undefined;
  let destination: { connectionId: string; listenerId: string } | undefined;
  const registerListener = async (actor: ArtifactActor): Promise<boolean> => {
    if (actor.role !== "agent") return false;
    const detected = detectListener(process.env);
    if (!detected.ok) {
      if (detected.reason === "missing-claude-token")
        throw new ArtifactCommandError("Claude messaging token is unavailable", 5);
      return false;
    }
    if (detected.target.harness === "codex" && !Bun.which("codex"))
      throw new ArtifactCommandError("The publisher cannot run codex queue; use r3 watch", 5);
    const target =
      detected.target.harness === "codex"
        ? {
            ...detected.target,
            executable: Bun.which("codex") ?? undefined,
            home: process.env.CODEX_HOME?.trim()
              ? resolve(process.env.CODEX_HOME.trim())
              : join(homedir(), ".codex"),
          }
        : detected.target;
    localWorker = await ensureWorker();
    destination = await localWorker.json("POST", "/api/local/target", {
      url: location.url,
      actor,
      target,
    });
    await client.json(
      "POST",
      `/api/workers/${encodeURIComponent(destination!.connectionId)}/targets`,
      {
        actor,
        listenerId: destination!.listenerId,
      },
    );
    return true;
  };
  return runArtifactCommand(command, args, {
    client,
    publicUrl: location.publicUrl,
    cwd: process.cwd(),
    environment: process.env,
    registerListener,
    stdin: stdinText,
    write: writeArtifactOutput,
    error: (text) => {
      process.stderr.write(`${text}\n`);
    },
    listen: async (id, actor, _foreground, quiet) => {
      if (!(await registerListener(actor)) || !destination || !localWorker)
        throw new ArtifactCommandError("No local wake adapter is available; use r3 watch", 5);
      const subscription: WorkerSubscription = {
        id: randomUUID(),
        artifactId: id,
        actor,
        mode: "explicit",
        listenerId: destination.listenerId,
      };
      await client.json(
        "POST",
        `/api/workers/${encodeURIComponent(destination.connectionId)}/listen`,
        subscription,
      );
      if (!quiet) process.stdout.write(`Listening on ${id}\n`);
      return 0;
    },
  });
}

export async function runArtifactCli(): Promise<void> {
  try {
    process.exitCode = await artifactMain();
  } catch (error) {
    const exitCode =
      error instanceof ArtifactCommandError
        ? error.exitCode
        : error instanceof ArtifactApiError && error.status === 409
          ? 4
          : 1;
    process.send?.({
      error: "Listener failed before registering; verify the local wake adapter or use r3 watch",
      exitCode,
    });
    process.stderr.write(`r3: ${error instanceof Error ? error.message : "Command failed"}\n`);
    process.exitCode = exitCode;
  }
}
if (import.meta.main) await runArtifactCli();
