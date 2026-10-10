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
import type { WorkerRecords } from "./worker-records.ts";

type CloseReason = "archived" | "superseded" | "deleted" | "disconnected";
interface Registration {
  retainOnFailure?: boolean;
  info: ArtifactWatcher;
  close: (reason: CloseReason) => void;
  push?: (nudge: ArtifactNudge) => Promise<void> | Promise<"sent" | "queued">;
}

// One designated recipient is transport presence, never ownership of the
// artifact. Every other registered agent can still read, publish, claim or comment.
export class ArtifactCollaboration {
  private readonly registrations = new Map<string, Registration>();
  private readonly fallbacks = new Map<string, Registration>();
  private readonly subscribers = new Set<(event: ArtifactStreamEvent) => void>();
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly conversations: ArtifactConversations,
    private readonly lifecycle: ArtifactLifecycle,
    private readonly clock: () => string = nowIso,
    private readonly workerRecords?: WorkerRecords,
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

  sessionLabelChanged(sessionId: string, label: string | null): void {
    const affected = new Set(this.artifacts.artifactsForSession(sessionId));
    for (const [id, held] of [...this.registrations, ...this.fallbacks]) {
      if (held.info.actor.sessionId !== sessionId) continue;
      held.info = { ...held.info, label };
      affected.add(id);
    }
    // A full snapshot refreshes labels for unchanged publications and comments,
    // which are intentionally absent from ordinary conversation deltas.
    for (const artifactId of affected) this.broadcast({ type: "artifact-updated", artifactId });
  }

  watching(id: string): boolean {
    return !!this.recipient(id);
  }
  watchers(id: string): ArtifactWatcher[] {
    this.artifacts.get(id);
    const held = this.recipient(id);
    return held ? [held.info] : [];
  }

  private recipient(id: string): Registration | undefined {
    return this.registrations.get(id) ?? this.fallbacks.get(id);
  }

  unlisten(id: string, actor: ArtifactActor): void {
    actor = this.artifacts.validateActor(actor);
    this.artifacts.get(id);
    if (actor.role === "agent") this.workerRecords?.retire(id, null, actor);
    const held = this.registrations.get(id);
    if (held?.info.actor.role === actor.role && held.info.actor.sessionId === actor.sessionId)
      this.unregister(id, held.info.id);
    const fallback = this.fallbacks.get(id);
    if (
      fallback?.info.actor.role === actor.role &&
      fallback.info.actor.sessionId === actor.sessionId
    )
      this.unregister(id, fallback.info.id);
    this.broadcast({ type: "presence-changed", artifactId: id });
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
    options: {
      mode?: "fallback" | "explicit";
      id?: string;
      listenerId?: string;
      retainOnFailure?: boolean;
    } = {},
  ): ArtifactWatcher {
    actor = this.artifacts.validateActor(actor);
    if (push && actor.role !== "agent")
      throw new ArtifactError("Listeners require an agent session");
    if (this.artifacts.get(id).state !== "active")
      throw new ArtifactError("Artifact is archived", 409);
    const map = options.mode === "fallback" ? this.fallbacks : this.registrations;
    const held = map.get(id);
    this.workerRecords?.retire(id, options.mode ?? "explicit", null, options.id);
    const info: ArtifactWatcher = {
      id: options.id ?? randomUUID(),
      kind: push ? "listen" : "watch",
      actor,
      connectedAt: this.clock(),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.listenerId ? { listenerId: options.listenerId } : {}),
      ...(options.mode && actor.role === "agent"
        ? { label: this.artifacts.sessionLabels([actor.sessionId])[actor.sessionId] ?? null }
        : {}),
    };
    map.set(id, { info, close, push, retainOnFailure: options.retainOnFailure });
    if (held) this.close(held, "superseded");
    this.broadcast({ type: "presence-changed", artifactId: id });
    return info;
  }

  unregister(id: string, registrationId: string): void {
    const map =
      this.fallbacks.get(id)?.info.id === registrationId ? this.fallbacks : this.registrations;
    const held = map.get(id);
    if (held?.info.id !== registrationId) return;
    map.delete(id);
    this.close(held, "disconnected");
    this.broadcast({ type: "presence-changed", artifactId: id });
  }

  connectionState(
    id: string,
    subscriptionId: string,
    state: NonNullable<ArtifactWatcher["connectionState"]>,
    error: string | null = null,
  ): void {
    const held = [this.registrations.get(id), this.fallbacks.get(id)].find(
      (value) => value?.info.id === subscriptionId,
    );
    if (!held) return;
    held.info = { ...held.info, connectionState: state, error };
    this.broadcast({ type: "presence-changed", artifactId: id });
  }

  clearFallback(id: string): void {
    const held = this.fallbacks.get(id);
    this.fallbacks.delete(id);
    if (held) this.close(held, "superseded");
  }

  registration(id: string, mode: "fallback" | "explicit"): ArtifactWatcher | undefined {
    return (mode === "fallback" ? this.fallbacks : this.registrations).get(id)?.info;
  }

  private async notify(
    id: string,
    held: Registration | undefined,
    nudge: ArtifactNudge,
  ): Promise<ArtifactNotification> {
    if (!held?.push) return { state: "none" };
    try {
      const state = await held.push(nudge);
      return { state: state ?? "sent" };
    } catch (error) {
      if (!held.retainOnFailure && held.info.mode !== "fallback") this.unregister(id, held.info.id);
      this.broadcast({ type: "presence-changed", artifactId: id });
      return {
        state: "failed",
        error: error instanceof Error ? error.message : "Agent delivery failed",
      };
    }
  }

  async submit(id: string): Promise<ArtifactNotification> {
    const artifact = this.artifacts.get(id);
    if (artifact.state !== "active") throw new ArtifactError("Artifact is archived", 409);
    const held = this.recipient(id);
    const wakesWatch = held?.info.kind === "watch" && this.conversations.hasPending(id);
    this.broadcast({ type: "submitted", artifactId: id });
    // The synchronous broadcast completes a pending generic watch. Like a local
    // harness acknowledgment, this confirms the wake without draining threads.
    if (wakesWatch) return { state: "sent" };
    return this.notify(id, held, {
      id: randomUUID(),
      artifactId: id,
      title: artifact.title,
      event: "submitted",
      lifecycleEventId: null,
      comment: null,
    });
  }

  async transition(id: string, value: unknown): Promise<ArtifactLifecycleResponse> {
    const held = this.recipient(id);
    // No await between the committed state transition and detaching presence.
    // A retry must neither evict a newer registration nor repeat notification.
    const result = this.lifecycle.transition(id, value);
    if (result.replayed) return { ...result, notification: { state: "not_repeated" } };
    if (result.event.event === "archived") {
      const fallback = this.fallbacks.get(id);
      this.fallbacks.delete(id);
      this.registrations.delete(id);
      if (fallback && fallback !== held) this.close(fallback, "archived");
    }
    this.broadcast({ type: "lifecycle", artifactId: id, event: result.event });
    if (result.event.event !== "archived") return { ...result, notification: { state: "none" } };
    this.broadcast({ type: "presence-changed", artifactId: id });
    let notification: ArtifactNotification = { state: "none" };
    try {
      if (result.event.comment !== null)
        notification = await this.notify(id, held, {
          id: randomUUID(),
          artifactId: id,
          title: this.artifacts.get(id).title,
          event: "archived",
          lifecycleEventId: result.event.id,
          comment: {
            id: result.event.comment.id,
            body: result.event.comment.body.slice(0, 8000),
            truncated: result.event.comment.body.length > 8000,
          },
        });
      if (
        result.event.comment &&
        result.event.comment.body.length <= 8000 &&
        (notification.state === "sent" || notification.state === "queued")
      ) {
        this.conversations.acknowledgeArchiveComment(result.event.comment.id);
        result.event.comment = this.conversations.comment(result.event.comment.id);
        this.broadcast({ type: "artifact-updated", artifactId: id });
      }
      return { ...result, notification };
    } finally {
      if (held) this.close(held, "archived");
    }
  }

  deleted(id: string): void {
    const held = this.registrations.get(id);
    this.registrations.delete(id);
    const fallback = this.fallbacks.get(id);
    this.fallbacks.delete(id);
    this.broadcast({ type: "artifact-deleted", artifactId: id });
    if (held) this.close(held, "deleted");
    if (fallback) this.close(fallback, "deleted");
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
          else if (event.type === "submitted" && this.conversations.hasPending(id))
            finish({ result: "comments" });
        });
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => finish(archived() ?? { result: "timeout" }), timeout);
        if (this.conversations.hasPending(id)) finish(archived() ?? { result: "comments" });
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
