import type {
  ArtifactActor,
  ArtifactAgentStreamEvent,
  ArtifactNudge,
  ArtifactWatcher,
} from "../shared/artifacts.ts";
import type { ArtifactCollaboration } from "./artifact-collaboration.ts";
import {
  ArtifactError,
  optionalText,
  requireActor,
  requireObject,
  requireString,
} from "./artifact-validation.ts";

interface Pending {
  settle: (error?: Error) => void;
}
interface Connection {
  registration: ArtifactWatcher;
  pending: Map<string, Pending>;
  close: () => void;
}

// The publisher opens this outward stream and performs harness delivery locally.
// The daemon sees session IDs and acknowledgments, never harness sockets,
// executable paths, or harness credentials. Transport state is only in memory.
export class AgentConnections {
  private readonly connections = new Map<string, Connection>();
  constructor(
    private readonly collaboration: ArtifactCollaboration,
    private readonly acknowledgmentTimeoutMs = 15_000,
  ) {}

  open(
    artifactId: string,
    actor: ArtifactActor,
  ): { registration: ArtifactWatcher; stream: ReadableStream<Uint8Array> } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let registration: ArtifactWatcher | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const pending = new Map<string, Pending>();
    const send = (event: ArtifactAgentStreamEvent) => {
      if (closed) throw new Error("Agent connection is closed");
      controller.enqueue(
        new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    };
    const close = (
      reason: Extract<ArtifactAgentStreamEvent, { type: "closed" }>["reason"] = "disconnected",
    ) => {
      if (closed) return;
      try {
        send({ type: "closed", reason });
        controller.close();
      } catch {
        /* Cancelled streams are already closed. */
      }
      closed = true;
      clearInterval(heartbeat);
      for (const item of pending.values())
        item.settle(new Error("Agent connection closed before delivery acknowledgment"));
      if (registration) {
        this.connections.delete(registration.id);
        this.collaboration.unregister(artifactId, registration.id);
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
      },
      cancel: () => close(),
    });
    const push = (nudge: ArtifactNudge): Promise<void> => {
      if (closed) return Promise.reject(new Error("Agent connection is closed"));
      if (pending.size >= 32)
        return Promise.reject(new Error("Agent has too many unacknowledged notifications"));
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const settle = (error?: Error) => {
          if (!pending.delete(nudge.id)) return;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        pending.set(nudge.id, { settle });
        timer = setTimeout(
          () => settle(new Error("Agent delivery acknowledgment timed out")),
          this.acknowledgmentTimeoutMs,
        );
        try {
          send({ type: "nudge", nudge });
        } catch (error) {
          settle(error instanceof Error ? error : new Error("Agent stream write failed"));
        }
      });
    };
    try {
      // Register before returning an HTTP stream so a conflict can be a 409.
      registration = this.collaboration.register(artifactId, actor, close, push);
      this.connections.set(registration.id, { registration, pending, close });
      send({ type: "ready", registration });
      heartbeat = setInterval(() => {
        try {
          send({ type: "heartbeat" });
        } catch {
          close();
        }
      }, 20_000);
      heartbeat.unref();
      return { registration, stream };
    } catch (error) {
      close();
      throw error;
    }
  }

  acknowledge(registrationId: string, value: unknown): void {
    const input = requireObject(value, "Delivery acknowledgment");
    const actor = requireActor(input.actor);
    const nudgeId = requireString(input.nudgeId, "nudgeId", 200);
    if (typeof input.ok !== "boolean")
      throw new ArtifactError("Acknowledgment requires an explicit delivery result");
    const error = optionalText(input.error, "Delivery error", 2000);
    const connection = this.connections.get(registrationId);
    if (!connection) throw new ArtifactError("Agent connection not found", 404);
    if (actor.role !== "agent" || actor.sessionId !== connection.registration.actor.sessionId)
      throw new ArtifactError("Acknowledgment must name the connected agent session", 409);
    const item = connection.pending.get(nudgeId);
    if (!item) throw new ArtifactError("Notification is no longer awaiting acknowledgment", 404);
    item.settle(input.ok ? undefined : new Error(error || "Local harness delivery failed"));
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
  }
}
