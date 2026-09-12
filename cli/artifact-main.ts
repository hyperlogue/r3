import { ArtifactApiError, ArtifactClient } from "../shared/artifact-client.ts";
import type { ArtifactActor } from "../shared/artifacts.ts";
import { R3_VERSION } from "../shared/version.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { runArtifactCommand } from "./artifact-commands.ts";
import { ARTIFACT_GUIDE, ARTIFACT_HELP } from "./artifact-help.ts";
import {
  listenArtifactConnection,
  localArtifactDelivery,
  startArtifactListenerProcess,
} from "./artifact-listener.ts";
import { authCommand, configCommand } from "./artifact-settings.ts";
import { cliProcessArgv, daemonCommand, discoverArtifactServer } from "./daemon-client.ts";

const COMMANDS = new Set([
  "create",
  "publish",
  "list",
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
  "prompt",
  "watch",
  "listen",
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

async function runListener(id: string, actor: ArtifactActor, ready?: () => void): Promise<number> {
  const location = await discoverArtifactServer();
  const client = new ArtifactClient(location);
  await client.checkProtocol();
  const deliver = await localArtifactDelivery(process.env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await listenArtifactConnection(client, id, actor, {
      deliver,
      ready,
      signal: controller.signal,
    });
    return 0;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

export async function artifactMain(argv = process.argv.slice(2)): Promise<number> {
  const [command = "help", ...args] = argv;
  if (["help", "--help", "-h"].includes(command)) {
    console.log(ARTIFACT_HELP);
    return 0;
  }
  if (["version", "--version", "-v"].includes(command)) {
    console.log(R3_VERSION);
    return 0;
  }
  if (command === "guide") {
    console.log(ARTIFACT_GUIDE);
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
  if (command === "__artifact_listener") {
    const id = process.env.R3_LISTENER_ARTIFACT;
    const sessionId = process.env.R3_LISTENER_SESSION;
    if (!id || !sessionId) throw new ArtifactCommandError("Missing listener identity");
    return runListener(id, { role: "agent", sessionId }, () => process.send?.({ ready: true }));
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
  return runArtifactCommand(command, args, {
    client,
    publicUrl: location.publicUrl,
    cwd: process.cwd(),
    environment: process.env,
    stdin: stdinText,
    write: (text) => {
      process.stdout.write(text);
    },
    error: (text) => {
      process.stderr.write(`${text}\n`);
    },
    listen: async (id, actor, foreground) => {
      if (foreground)
        return runListener(id, actor, () => process.stderr.write(`Listening on ${id}\n`));
      if (actor.role !== "agent")
        throw new ArtifactCommandError("Listeners require an agent session");
      await startArtifactListenerProcess({
        argv: cliProcessArgv("__artifact_listener"),
        environment: {
          ...process.env,
          R3_URL: location.url,
          R3_TOKEN: location.token,
          R3_LISTENER_ARTIFACT: id,
          R3_LISTENER_SESSION: actor.sessionId,
        },
        cwd: process.cwd(),
      });
      process.stdout.write(`Listening on ${id}\n`);
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
