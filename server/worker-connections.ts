import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { ArtifactActor, ArtifactDeliveryState, ArtifactNudge } from "../shared/artifacts.ts";
import {
  WORKER_DESTINATION_LIMIT,
  WORKER_PROTOCOL,
  type WorkerEvent,
  type WorkerSubscription,
} from "../shared/worker-protocol.ts";
import { type ArtifactAuthPolicy, artifactApiPrincipal } from "./artifact-auth.ts";
import type { ArtifactCollaboration } from "./artifact-collaboration.ts";
import { ARTIFACT_EVENT_HEADERS } from "./artifact-events.ts";
import { artifactJson } from "./artifact-http.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import {
  ArtifactError,
  canonicalJson,
  requireObject,
  requireString,
} from "./artifact-validation.ts";
import { observedAddress } from "./client-auth-api.ts";
import type { WorkerRecord } from "./worker-records.ts";

interface Connection {
  id: string;
  workerId: string;
  principal: string;
  closed: boolean;
  send(event: WorkerEvent): void;
  close(reason: string): void;
  targets: Map<string, ArtifactActor>;
  subscriptions: Map<string, WorkerSubscription>;
  pending: Map<string, (ok: boolean, state?: ArtifactDeliveryState) => void>;
  queues: Map<string, Promise<unknown>>;
  queued: Map<string, number>;
}

export class WorkerConnections {
  private readonly connections = new Map<string, Connection>();
  private readonly targets = new Map<string, { connection: Connection; listenerId: string }>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly storage: ArtifactStorage,
    private readonly collaboration: ArtifactCollaboration,
    private readonly policy: ArtifactAuthPolicy,
    private readonly deliveryTimeout = 15_000,
  ) {
    storage.workerRecords.startup();
    for (const record of storage.workerRecords.retained()) this.retain(record);
    this.unsubscribe = storage.clientAuth.onRevoked((id) => {
      for (const connection of this.connections.values())
        if (connection.principal === id) connection.close("authorization-revoked");
    });
  }

  open(request: Request, workerId: string): ReadableStream<Uint8Array> {
    const principal = artifactApiPrincipal(request, this.policy, this.storage.clientAuth);
    if (!principal) throw new ArtifactError("Worker requires a client credential", 401);
    for (const existing of this.connections.values())
      if (existing.workerId === workerId && existing.principal === principal.id)
        existing.close("reconnected");
    if (this.connections.size >= 128)
      throw new ArtifactError("Worker connection limit reached", 429);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let heartbeat: ReturnType<typeof setInterval>;
    let expiry: ReturnType<typeof setInterval>;
    const id = randomUUID();
    const connection: Connection = {
      id,
      workerId,
      principal: principal.id,
      closed: false,
      targets: new Map(),
      subscriptions: new Map(),
      pending: new Map(),
      queues: new Map(),
      queued: new Map(),
      send: (event) => {
        if (connection.closed) throw new ArtifactError("Worker is disconnected", 409);
        controller.enqueue(
          new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      },
      close: (reason) => {
        if (connection.closed) return;
        try {
          connection.send({ type: "closed", reason });
          controller.close();
        } catch {
          /* Reader is gone. */
        }
        connection.closed = true;
        clearInterval(heartbeat);
        clearInterval(expiry);
        this.connections.delete(id);
        for (const [session, target] of this.targets)
          if (target.connection === connection) this.targets.delete(session);
        for (const subscription of connection.subscriptions.values()) {
          this.storage.workerRecords.state(subscription.id, "disconnected");
          this.collaboration.connectionState(
            subscription.artifactId,
            subscription.id,
            "disconnected",
            reason === "authorization-revoked" || reason === "authorization-expired"
              ? "Worker access ended; sign in and listen again."
              : "Notification worker is disconnected. It will reconnect automatically.",
          );
        }
        for (const settle of [...connection.pending.values()]) settle(false);
      },
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
      },
      cancel: () => connection.close("disconnected"),
    });
    this.connections.set(id, connection);
    this.storage.clientAuth.observeWorker(principal.id, observedAddress(request, this.policy));
    const retained = this.storage.workerRecords
      .retained()
      .filter((record) => record.workerId === workerId && record.principal === principal.id);
    connection.send({
      type: "ready",
      protocol: WORKER_PROTOCOL,
      connectionId: id,
      listenerIds: [...new Set(retained.map((record) => record.subscription.listenerId))],
    });
    for (const record of retained) {
      this.attach(connection, record.subscription);
    }
    heartbeat = setInterval(() => {
      try {
        connection.send({ type: "heartbeat" });
      } catch {
        connection.close("disconnected");
      }
    }, 10_000);
    expiry = setInterval(() => {
      if (!artifactApiPrincipal(request, this.policy, this.storage.clientAuth))
        connection.close("authorization-expired");
    }, 1000);
    heartbeat.unref();
    expiry.unref();
    return stream;
  }

  private connection(request: Request, id: string): Connection {
    const value = this.connections.get(id);
    const principal = artifactApiPrincipal(request, this.policy, this.storage.clientAuth);
    if (!value || value.closed || value.principal !== principal?.id)
      throw new ArtifactError("Worker connection is unavailable", 409);
    return value;
  }
  private actor(value: unknown): ArtifactActor {
    const actor = this.storage.artifacts.validateActor(value);
    if (actor.role !== "agent")
      throw new ArtifactError("Worker listeners require an agent session");
    return actor;
  }
  private subscription(value: unknown): WorkerSubscription {
    const input = requireObject(value, "Subscription");
    if (input.mode !== "explicit" && input.mode !== "fallback")
      throw new ArtifactError("Invalid listener role");
    const artifactId = requireString(input.artifactId, "artifactId", 200);
    if (this.storage.artifacts.get(artifactId).state !== "active")
      throw new ArtifactError("Artifact is archived", 409);
    return {
      id: requireString(input.id, "registration id", 200),
      artifactId,
      listenerId: requireString(input.listenerId, "listenerId", 200),
      actor: this.actor(input.actor),
      mode: input.mode,
    };
  }
  private current(record: Pick<WorkerRecord, "workerId" | "principal">): Connection | undefined {
    return [...this.connections.values()].find(
      (connection) =>
        !connection.closed &&
        connection.workerId === record.workerId &&
        connection.principal === record.principal,
    );
  }
  private attach(connection: Connection, subscription: WorkerSubscription): void {
    const registration = this.collaboration.registration(
      subscription.artifactId,
      subscription.mode,
    );
    if (registration?.id !== subscription.id) return;
    connection.subscriptions.set(subscription.id, subscription);
    this.storage.workerRecords.state(subscription.id, "active");
    this.collaboration.connectionState(subscription.artifactId, subscription.id, "connected");
    connection.send({
      type: "registered",
      subscription,
      registration: { ...registration, connectionState: "connected", error: null },
    });
  }
  private retain(record: WorkerRecord) {
    const { subscription } = record;
    const registration = this.collaboration.register(
      subscription.artifactId,
      subscription.actor,
      (reason) => {
        this.storage.workerRecords.state(subscription.id, "retired");
        const connection = this.current(record);
        if (connection) {
          connection.subscriptions.delete(subscription.id);
          connection.send({ type: "retired", registrationId: subscription.id, reason });
        }
      },
      async (nudge) => {
        const connection = this.current(record);
        if (!connection)
          throw new Error(
            "Notification worker is disconnected; try again after it reconnects or listen from another agent.",
          );
        try {
          const result = await this.push(connection, subscription, nudge);
          if (this.current(record) === connection)
            this.collaboration.connectionState(
              subscription.artifactId,
              subscription.id,
              "connected",
            );
          return result;
        } catch (error) {
          if (this.current(record) === connection)
            this.collaboration.connectionState(
              subscription.artifactId,
              subscription.id,
              "failed",
              "Notification delivery failed. Try again or listen from another agent.",
            );
          throw error;
        }
      },
      {
        mode: subscription.mode,
        id: subscription.id,
        listenerId: subscription.listenerId,
        retainOnFailure: true,
      },
    );
    this.collaboration.connectionState(
      subscription.artifactId,
      subscription.id,
      "disconnected",
      "Notification worker is disconnected. It will reconnect automatically.",
    );
    return registration;
  }
  private register(connection: Connection, subscription: WorkerSubscription) {
    const actor = connection.targets.get(subscription.listenerId);
    if (!actor || actor.sessionId !== subscription.actor.sessionId)
      throw new ArtifactError("Listener is not registered on this connection", 409);
    const previous = this.storage.workerRecords.get(subscription.id);
    if (previous?.state === "retired") throw new ArtifactError("Registration has ended", 409);
    if (
      previous &&
      (previous.workerId !== connection.workerId ||
        previous.principal !== connection.principal ||
        canonicalJson(previous.subscription) !== canonicalJson(subscription))
    )
      throw new ArtifactError("Registration identity was already used", 409);
    const live = this.collaboration.registration(subscription.artifactId, subscription.mode);
    if (live?.id === subscription.id) return live;
    this.storage.workerRecords.save(connection.workerId, connection.principal, subscription);
    this.retain({
      workerId: connection.workerId,
      principal: connection.principal,
      subscription,
      state: "active",
    });
    this.attach(connection, subscription);
    return this.collaboration.registration(subscription.artifactId, subscription.mode)!;
  }
  private push(
    connection: Connection,
    subscription: WorkerSubscription,
    nudge: ArtifactNudge,
  ): Promise<ArtifactDeliveryState> {
    const key = subscription.listenerId;
    const count = connection.queued.get(key) ?? 0;
    if (count >= 6) return Promise.reject(new Error("Listener has too many pending notifications"));
    connection.queued.set(key, count + 1);
    const previous = connection.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(
        () =>
          new Promise<ArtifactDeliveryState>((resolve, reject) => {
            if (connection.closed) {
              reject(new Error("Worker disconnected before delivery"));
              return;
            }
            const timer = setTimeout(() => settle(false), this.deliveryTimeout);
            const settle = (ok: boolean, state: ArtifactDeliveryState = "sent") => {
              if (!connection.pending.delete(nudge.id)) return;
              clearTimeout(timer);
              if (ok) resolve(state);
              else reject(new Error("Worker could not deliver the notification"));
            };
            connection.pending.set(nudge.id, settle);
            try {
              connection.send({
                type: "nudge",
                registrationId: subscription.id,
                listenerId: key,
                nudge,
              });
            } catch {
              settle(false);
            }
          }),
      )
      .finally(() => {
        connection.queued.set(key, (connection.queued.get(key) ?? 1) - 1);
        if (connection.queues.get(key) === next) connection.queues.delete(key);
      });
    connection.queues.set(key, next);
    return next;
  }
  published(id: string, actor: ArtifactActor, enabled: boolean): WorkerSubscription | undefined {
    this.collaboration.clearFallback(id);
    const target = actor.role === "agent" ? this.targets.get(actor.sessionId) : undefined;
    if (!enabled || !target || target.connection.closed) return;
    const subscription: WorkerSubscription = {
      id: randomUUID(),
      artifactId: id,
      actor,
      mode: "fallback",
      listenerId: target.listenerId,
    };
    try {
      this.register(target.connection, subscription);
      return subscription;
    } catch {
      target.connection.close("registration-failed");
      return undefined;
    }
  }
  install(app: Hono): void {
    app.post("/api/workers/connect", async (c) => {
      const body = await artifactJson(c.req.raw, 8192);
      if (body.protocol !== WORKER_PROTOCOL)
        throw new ArtifactError("Unsupported worker protocol", 409);
      return new Response(this.open(c.req.raw, requireString(body.workerId, "workerId", 200)), {
        headers: ARTIFACT_EVENT_HEADERS,
      });
    });
    app.post("/api/workers/:id/targets", async (c) => {
      const connection = this.connection(c.req.raw, c.req.param("id"));
      const body = await artifactJson(c.req.raw, 8192);
      const actor = this.actor(body.actor);
      const listenerId = requireString(body.listenerId, "listenerId", 200);
      if (
        connection.targets.size >= WORKER_DESTINATION_LIMIT &&
        !connection.targets.has(listenerId)
      ) {
        const subscribed = new Set(
          [...connection.subscriptions.values()].map((value) => value.listenerId),
        );
        const unused = [...connection.targets.keys()].find((id) => !subscribed.has(id));
        if (!unused) throw new ArtifactError("Listener limit reached", 429);
        connection.targets.delete(unused);
        for (const [session, target] of this.targets)
          if (target.connection === connection && target.listenerId === unused)
            this.targets.delete(session);
      }
      // Keep recent CLI setup at the end; only unused bindings may be evicted.
      connection.targets.delete(listenerId);
      connection.targets.set(listenerId, actor);
      this.targets.set(actor.sessionId!, { connection, listenerId });
      return c.json({ ok: true });
    });
    app.post("/api/workers/:id/listen", async (c) => {
      const connection = this.connection(c.req.raw, c.req.param("id"));
      const subscription = this.subscription(await artifactJson(c.req.raw, 8192));
      if (subscription.mode !== "explicit")
        throw new ArtifactError("Fallback registration belongs to publication");
      return c.json(this.register(connection, subscription));
    });
    app.post("/api/workers/:id/acknowledgments", async (c) => {
      const connection = this.connection(c.req.raw, c.req.param("id"));
      const body = await artifactJson(c.req.raw, 8192);
      if (
        typeof body.ok !== "boolean" ||
        (body.state !== undefined && body.state !== "sent" && body.state !== "queued")
      )
        throw new ArtifactError("Invalid delivery result");
      const settle = connection.pending.get(requireString(body.nudgeId, "nudgeId", 200));
      if (!settle) throw new ArtifactError("Notification is no longer pending", 409);
      settle(body.ok, body.state as ArtifactDeliveryState | undefined);
      return c.json({ ok: true });
    });
  }
  close(): void {
    this.unsubscribe();
    for (const connection of [...this.connections.values()]) connection.close("server-stopped");
  }
}
