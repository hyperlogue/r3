import { randomUUID } from "node:crypto";
import type {
  ArtifactActor,
  ArtifactLifecycleResponse,
  ArtifactNotification,
  ArtifactNudge,
  ArtifactStreamEvent,
  ArtifactWatcher,
  ArtifactWatchResult,
} from "../shared/artifacts.ts";
import type { ArtifactConversations } from "./artifact-conversations.ts";
import type { ArtifactLifecycle } from "./artifact-lifecycle.ts";
import { ArtifactError } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { nowIso } from "./ids.ts";

type CloseReason = "archived" | "superseded" | "deleted" | "disconnected";
interface Registration {
  info: ArtifactWatcher;
  close: (reason: CloseReason) => void;
  push?: (nudge: ArtifactNudge) => Promise<void>;
}

// One designated recipient is transport presence, never ownership of the
// artifact. Every other registered agent can still read, publish, claim or reply.
export class ArtifactCollaboration {
  private readonly registrations = new Map<string, Registration>();
  private readonly subscribers = new Set<(event: ArtifactStreamEvent) => void>();
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly conversations: ArtifactConversations,
    private readonly lifecycle: ArtifactLifecycle,
    private readonly clock: () => string = nowIso,
  ) {}

  subscribe(listener: (event: ArtifactStreamEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  broadcast(event: ArtifactStreamEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        /* A disconnected reader cannot break a write. */
      }
    }
  }

  watching(id: string): boolean {
    return this.registrations.has(id);
  }
  watchers(id: string): ArtifactWatcher[] {
    this.artifacts.get(id);
    const held = this.registrations.get(id);
    return held ? [held.info] : [];
  }

  private close(held: Registration, reason: CloseReason): void {
    try {
      held.close(reason);
    } catch {
      /* The transport is already being discarded. */
    }
  }

  register(
    id: string,
    actor: ArtifactActor,
    close: Registration["close"],
    push?: Registration["push"],
  ): ArtifactWatcher {
    actor = this.artifacts.validateActor(actor);
    if (push && actor.role !== "agent")
      throw new ArtifactError("Listeners require an agent session");
    if (this.artifacts.get(id).state !== "active")
      throw new ArtifactError("Artifact is archived", 409);
    const held = this.registrations.get(id);
    if (
      held &&
      (held.info.actor.role !== actor.role || held.info.actor.sessionId !== actor.sessionId)
    )
      throw new ArtifactError("Artifact already has a designated watcher", 409);
    const info: ArtifactWatcher = {
      id: randomUUID(),
      kind: push ? "listen" : "watch",
      actor,
      connectedAt: this.clock(),
    };
    this.registrations.set(id, { info, close, push });
    if (held) this.close(held, "superseded");
    this.broadcast({ type: "presence-changed", artifactId: id });
    return info;
  }

  unregister(id: string, registrationId: string): void {
    const held = this.registrations.get(id);
    if (held?.info.id !== registrationId) return;
    this.registrations.delete(id);
    this.close(held, "disconnected");
    this.broadcast({ type: "presence-changed", artifactId: id });
  }

  private async notify(
    id: string,
    held: Registration | undefined,
    nudge: ArtifactNudge,
  ): Promise<ArtifactNotification> {
    if (!held?.push) return { state: "none" };
    try {
      await held.push(nudge);
      return { state: "sent" };
    } catch (error) {
      this.unregister(id, held.info.id);
      return {
        state: "failed",
        error: error instanceof Error ? error.message : "Agent delivery failed",
      };
    }
  }

  async submit(id: string): Promise<ArtifactNotification> {
    const artifact = this.artifacts.get(id);
    if (artifact.state !== "active") throw new ArtifactError("Artifact is archived", 409);
    const held = this.registrations.get(id);
    const wakesWatch = held?.info.kind === "watch" && this.conversations.unsent(id).length > 0;
    this.broadcast({ type: "submitted", artifactId: id });
    // The synchronous broadcast completes a pending generic watch. Like a local
    // harness acknowledgment, this confirms the wake without draining feedback.
    if (wakesWatch) return { state: "sent" };
    return this.notify(id, held, {
      id: randomUUID(),
      artifactId: id,
      title: artifact.title,
      event: "submitted",
      lifecycleEventId: null,
      message: null,
    });
  }

  async notifyPending(id: string, registrationId: string): Promise<ArtifactNotification> {
    const held = this.registrations.get(id);
    if (held?.info.id !== registrationId || !this.conversations.unsent(id).length)
      return { state: "none" };
    return this.submit(id);
  }

  async transition(id: string, value: unknown): Promise<ArtifactLifecycleResponse> {
    const held = this.registrations.get(id);
    // No await between the committed state transition and detaching presence.
    // A retry must neither evict a newer registration nor repeat notification.
    const result = this.lifecycle.transition(id, value);
    if (result.replayed) return { ...result, notification: { state: "not_repeated" } };
    if (result.event.event === "archived") this.registrations.delete(id);
    this.broadcast({ type: "lifecycle", artifactId: id, event: result.event });
    if (result.event.event !== "archived") return { ...result, notification: { state: "none" } };
    this.broadcast({ type: "presence-changed", artifactId: id });
    let notification: ArtifactNotification = { state: "none" };
    try {
      if (result.event.message !== null)
        notification = await this.notify(id, held, {
          id: randomUUID(),
          artifactId: id,
          title: this.artifacts.get(id).title,
          event: "archived",
          lifecycleEventId: result.event.id,
          message: result.event.message,
        });
      return { ...result, notification };
    } finally {
      if (held) this.close(held, "archived");
    }
  }

  deleted(id: string): void {
    const held = this.registrations.get(id);
    this.registrations.delete(id);
    this.broadcast({ type: "artifact-deleted", artifactId: id });
    if (held) this.close(held, "deleted");
  }

  watch(
    id: string,
    actor: ArtifactActor,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ArtifactWatchResult> {
    this.artifacts.validateActor(actor);
    this.artifacts.get(id);
    const archived = (): ArtifactWatchResult | null =>
      this.artifacts.get(id).state === "archived"
        ? {
            result: "archived",
            event:
              this.lifecycle.events(id).findLast((event) => event.event === "archived") ?? null,
          }
        : null;
    const terminal = archived();
    if (terminal) return Promise.resolve(terminal);
    if (options.signal?.aborted) return Promise.resolve({ result: "cancelled" });
    const timeout = options.timeoutMs ?? 55_000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300_000)
      throw new ArtifactError("Watch timeout must be between 1 and 300000 milliseconds");
    return new Promise((resolve, reject) => {
      let info: ArtifactWatcher | undefined;
      let settled = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => finish({ result: "cancelled" });
      const finish = (result: ArtifactWatchResult) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (info) this.unregister(id, info.id);
        resolve(result);
      };
      try {
        info = this.register(id, actor, (reason) => {
          if (reason === "archived") finish(archived() ?? { result: "cancelled" });
          else finish({ result: reason === "disconnected" ? "cancelled" : reason });
        });
        if (settled) return;
        unsubscribe = this.subscribe((event) => {
          if (event.artifactId !== id) return;
          if (event.type === "artifact-deleted") {
            finish({ result: "deleted" });
            return;
          }
          if (event.type !== "submitted" && event.type !== "lifecycle") return;
          const terminal = archived();
          if (terminal) finish(terminal);
          else if (event.type === "submitted" && this.conversations.unsent(id).length)
            finish({ result: "feedback" });
        });
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => finish(archived() ?? { result: "timeout" }), timeout);
        if (this.conversations.unsent(id).length) finish(archived() ?? { result: "feedback" });
      } catch (error) {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (info) this.unregister(id, info.id);
        reject(error);
      }
    });
  }
}
