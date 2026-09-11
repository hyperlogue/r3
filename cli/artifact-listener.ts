import {
  listenerTransportAvailable,
  parseListenerTarget,
  probeListener,
  pushToListener,
} from "../server/listener.ts";
import { type ArtifactClient, artifactApiPath } from "../shared/artifact-client.ts";
import { artifactNudgeText } from "../shared/artifact-prompt.ts";
import type {
  ArtifactActor,
  ArtifactAgentStreamEvent,
  ArtifactWatcher,
} from "../shared/artifacts.ts";
import { readEventStream } from "../shared/event-stream.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { detectListener } from "./listener.ts";

export type ArtifactNudgeDelivery = (text: string) => Promise<void>;

// All harness discovery, capability checks, and message delivery run on the
// publisher. The server only receives the logical actor and delivery result.
export async function localArtifactDelivery(
  environment: Record<string, string | undefined>,
): Promise<ArtifactNudgeDelivery> {
  const detection = detectListener(environment);
  if (!detection.ok)
    throw new ArtifactCommandError("No supported local wake adapter is available; use r3 watch", 5);
  const parsed = parseListenerTarget(detection.target);
  if (!parsed.ok) throw new ArtifactCommandError(parsed.error, 5);
  if (!(await listenerTransportAvailable(parsed.target)))
    throw new ArtifactCommandError("The publisher cannot run codex queue; use r3 watch", 5);
  if ((await probeListener(parsed.target)) === "dead")
    throw new ArtifactCommandError("The local harness socket is unavailable; use r3 watch", 5);
  return (text) => pushToListener(parsed.target, text);
}

export async function listenArtifactConnection(
  client: ArtifactClient,
  id: string,
  actor: ArtifactActor,
  options: {
    deliver: ArtifactNudgeDelivery;
    ready?: (registration: ArtifactWatcher) => void;
    signal?: AbortSignal;
  },
): Promise<"archived" | "superseded" | "deleted" | "disconnected"> {
  if (actor.role !== "agent") throw new ArtifactCommandError("Listeners require an agent session");
  // Explicit signal removes the ordinary command timeout from a held stream.
  const signal = options.signal ?? new AbortController().signal;
  const response = await client.request("POST", `${artifactApiPath(id)}/listen`, { actor }, signal);
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream"))
    throw new Error("r3 did not return an agent event stream");
  let registration: ArtifactWatcher | undefined;
  for await (const frame of readEventStream(response.body)) {
    const event = JSON.parse(frame.data) as ArtifactAgentStreamEvent;
    if (event.type === "ready") {
      if (
        registration ||
        event.registration.actor.role !== "agent" ||
        event.registration.actor.sessionId !== actor.sessionId
      )
        throw new Error("Agent stream registered a different session");
      registration = event.registration;
      options.ready?.(registration);
    } else if (event.type === "nudge") {
      if (!registration || event.nudge.artifactId !== id)
        throw new Error("Agent stream sent an unrelated notification");
      let ok = true;
      try {
        await options.deliver(artifactNudgeText(event.nudge));
      } catch {
        ok = false;
      }
      // Do not relay harness errors: they can contain local paths or credentials.
      await client.json(
        "POST",
        `/api/connections/${encodeURIComponent(registration.id)}/acknowledgments`,
        {
          actor,
          nudgeId: event.nudge.id,
          ok,
          ...(ok ? {} : { error: "Local harness delivery failed" }),
        },
      );
      if (!ok)
        throw new ArtifactCommandError("Local harness delivery failed; listener disconnected");
    } else if (event.type === "closed") return event.reason;
  }
  return "disconnected";
}

// The parent returns only after the outward connection registers. Neither argv
// nor a temporary file carries credentials; inherited environment stays local.
export function startArtifactListenerProcess(options: {
  argv: string[];
  environment: Record<string, string | undefined>;
  cwd: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const child = Bun.spawn(options.argv, {
      cwd: options.cwd,
      env: options.environment,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      serialization: "json",
      ipc(message: unknown) {
        if (settled || !message || typeof message !== "object") return;
        const value = message as { ready?: unknown; error?: unknown; exitCode?: unknown };
        if (value.ready === true) {
          settled = true;
          clearTimeout(timer);
          child.disconnect();
          child.unref();
          resolve(child.pid);
        } else if (typeof value.error === "string") {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(
            new ArtifactCommandError(
              value.error,
              typeof value.exitCode === "number" ? value.exitCode : 1,
            ),
          );
        }
      },
      onExit(_child, exitCode) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ArtifactCommandError(`Listener exited before registering (${exitCode})`));
      },
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ArtifactCommandError("Listener registration timed out"));
    }, 20_000);
  });
}
