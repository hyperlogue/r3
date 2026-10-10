import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { artifactJson } from "../server/artifact-http.ts";
import { ArtifactError, requireActor, requireString } from "../server/artifact-validation.ts";
import { daemonJsonPath, stateDir } from "../server/config.ts";
import { parseListenerTarget } from "../server/listener.ts";
import { deliverLocalAgent } from "../server/local-agents.ts";
import { ArtifactApiError, ArtifactClient } from "../shared/artifact-client.ts";
import { artifactNudgeText } from "../shared/artifact-prompt.ts";
import type { ArtifactActor } from "../shared/artifacts.ts";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import { readEventStream } from "../shared/event-stream.ts";
import type { ListenerTarget } from "../shared/types.ts";
import {
  WORKER_DESTINATION_LIMIT,
  WORKER_PROTOCOL,
  type WorkerEvent,
  type WorkerSubscription,
} from "../shared/worker-protocol.ts";
import { BackendCredentials } from "./backend.ts";
import {
  privateDirectory,
  readPrivateJson,
  withPrivateLock,
  writePrivateJson,
} from "./private-state.ts";

export const workerInfoPath = () => join(dirname(daemonJsonPath()), "worker.json");
export interface WorkerInfo {
  pid: number;
  socket: string;
  token: string;
}
interface Target {
  id: string;
  url: string;
  actor: ArtifactActor;
  target: ListenerTarget;
}
interface Subscription extends WorkerSubscription {
  url: string;
  status: "active";
}
interface State {
  version: 2;
  workerId: string;
  targets: Target[];
}
interface Backend {
  controller: AbortController;
  connectionId?: string;
  listenerIds?: Set<string>;
  status: "connecting" | "ready" | "login-required" | "retrying";
  task: Promise<void>;
  ready: ReturnType<typeof Promise.withResolvers<string>>;
}
const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

// One writer owns this private file. Artifacts and threads are never cached here.
export class WorkerRuntime {
  private state: State;
  private subscriptions: Subscription[] = [];
  private readonly backends = new Map<string, Backend>();
  private stopping = false;
  constructor(
    private readonly path = join(stateDir(), "worker-state.json"),
    private readonly credentials = new BackendCredentials(),
    private readonly delivery = deliverLocalAgent,
    private readonly send: (request: Request) => Promise<Response> = (request) => fetch(request),
  ) {
    const saved = readPrivateJson<State & { version: number }>(path);
    if (saved && (![1, 2].includes(saved.version) || !Array.isArray(saved.targets)))
      throw new Error("Unsupported worker state format");
    this.state = {
      version: 2,
      workerId: saved?.workerId ?? randomUUID(),
      targets: saved?.targets ?? [],
    };
    // Discard obsolete transfer files without reading their harness credentials.
    rmSync(join(dirname(this.path), "worker-import.json"), { force: true });
    this.save();
  }
  private save(): void {
    writePrivateJson(this.path, this.state);
  }
  private prune(url: string): void {
    const backend = this.backends.get(url);
    const retained = backend?.listenerIds;
    // Older servers omit the snapshot. Preserve destinations until the backend
    // can tell us which subscriptions still need them.
    if (!retained || backend.status !== "ready") return;
    let unused = 0;
    const targets = this.state.targets
      .toReversed()
      .filter((target) => {
        if (target.url !== url || retained.has(target.id)) return true;
        unused++;
        return unused <= WORKER_DESTINATION_LIMIT;
      })
      .reverse();
    if (targets.length === this.state.targets.length) return;
    this.state.targets = targets;
    this.save();
  }
  private client(url: string): ArtifactClient {
    return new ArtifactClient({
      url,
      getToken: () => this.credentials.token(url),
      fetch: this.send,
    });
  }
  start(): void {
    for (const url of new Set(this.state.targets.map((value) => value.url))) this.connect(url);
  }
  private connect(url: string): Backend {
    const previous = this.backends.get(url);
    if (previous) return previous;
    const backend: Backend = {
      controller: new AbortController(),
      status: "connecting",
      task: Promise.resolve(),
      ready: Promise.withResolvers<string>(),
    };
    // Readiness failures are also reflected by status; callers may arrive later.
    void backend.ready.promise.catch(() => {});
    this.backends.set(url, backend);
    backend.task = this.run(url, backend).catch(() => {
      backend.status = "retrying";
    });
    return backend;
  }
  private async run(url: string, backend: Backend): Promise<void> {
    const signal = backend.controller.signal;
    let delay = 500;
    while (!signal.aborted && !this.stopping) {
      const attempt = new AbortController();
      const aborted = () => attempt.abort();
      signal.addEventListener("abort", aborted, { once: true });
      let connected = false;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      const alive = () => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => attempt.abort(), 35_000);
      };
      try {
        backend.status = "connecting";
        const client = this.client(url);
        alive();
        const response = await client.request(
          "POST",
          "/api/workers/connect",
          { workerId: this.state.workerId, protocol: WORKER_PROTOCOL },
          attempt.signal,
        );
        if (
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          throw new Error("Invalid worker stream");
        let ready = false;
        for await (const frame of readEventStream(response.body)) {
          alive();
          const event = JSON.parse(frame.data) as WorkerEvent;
          if (event.type === "ready") {
            if (
              ready ||
              event.protocol !== WORKER_PROTOCOL ||
              typeof event.connectionId !== "string" ||
              (event.listenerIds !== undefined &&
                (!Array.isArray(event.listenerIds) ||
                  event.listenerIds.some((id) => typeof id !== "string")))
            )
              throw new Error("Invalid worker handshake");
            ready = true;
            backend.connectionId = event.connectionId;
            backend.listenerIds = event.listenerIds ? new Set(event.listenerIds) : undefined;
            backend.status = "ready";
            this.prune(url);
            backend.ready.resolve(event.connectionId);
            connected = true;
            delay = 500;
          } else if (!ready) throw new Error("Worker stream did not start with ready");
          else if (event.type === "registered") {
            backend.listenerIds?.add(event.subscription.listenerId);
            const target = this.state.targets.find(
              (value) =>
                value.url === url &&
                value.id === event.subscription.listenerId &&
                value.actor.sessionId === event.subscription.actor.sessionId,
            );
            if (target) this.remember(url, event.subscription);
          } else if (event.type === "retired") {
            const retiring = this.subscriptions.find(
              (value) => value.url === url && value.id === event.registrationId,
            );
            const target = this.state.targets.find(
              (value) => value.url === url && value.id === retiring?.listenerId,
            );
            // A replacement may reuse this destination in the next frame.
            if (target) {
              this.state.targets = this.state.targets.filter((value) => value !== target);
              this.state.targets.push(target);
              this.save();
            }
            this.subscriptions = this.subscriptions.filter(
              (value) => value.url !== url || value.id !== event.registrationId,
            );
            if (backend.listenerIds)
              backend.listenerIds = new Set(
                this.subscriptions
                  .filter((value) => value.url === url)
                  .map((value) => value.listenerId),
              );
            this.prune(url);
          } else if (event.type === "nudge") {
            // Delivery is independent for every destination; do not block stream
            // processing, heartbeat handling, or another backend on a harness.
            void this.nudge(url, backend.connectionId!, event, attempt.signal).catch(() => {});
          } else if (event.type === "closed") break;
          else if (event.type === "heartbeat") this.prune(url);
          else throw new Error("Unknown worker event");
        }
      } catch (error) {
        const auth =
          (error instanceof ArtifactApiError && error.status === 401) ||
          (error instanceof Error && /run r3 login/.test(error.message));
        if (auth) {
          backend.status = "login-required";
          backend.ready.reject(new Error("Backend access is unavailable; run r3 login"));
          return;
        }
      } finally {
        attempt.abort();
        clearTimeout(heartbeat);
        signal.removeEventListener("abort", aborted);
        backend.connectionId = undefined;
        this.subscriptions = this.subscriptions.filter((value) => value.url !== url);
      }
      if (signal.aborted || this.stopping) break;
      backend.status = "retrying";
      if (connected) {
        backend.ready = Promise.withResolvers<string>();
        void backend.ready.promise.catch(() => {});
      }
      await wait(delay, signal);
      delay = Math.min(30_000, delay * 2);
    }
  }
  private async nudge(
    url: string,
    connectionId: string,
    event: Extract<WorkerEvent, { type: "nudge" }>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const subscription = this.subscriptions.find(
      (value) => value.url === url && value.id === event.registrationId,
    );
    const target = this.state.targets.find(
      (value) => value.url === url && value.id === event.listenerId,
    );
    let state: "sent" | "queued" | undefined;
    if (
      subscription &&
      target &&
      subscription.listenerId === target.id &&
      subscription.artifactId === event.nudge.artifactId
    ) {
      const parsed = parseListenerTarget(target.target);
      if (parsed.ok) {
        try {
          state = await this.delivery(parsed.target, artifactNudgeText(event.nudge));
        } catch {
          /* Report no local details. */
        }
      }
    }
    if (signal.aborted) return;
    await this.client(url).json(
      "POST",
      `/api/workers/${encodeURIComponent(connectionId)}/acknowledgments`,
      { nudgeId: event.nudge.id, ok: state !== undefined, ...(state ? { state } : {}) },
      signal,
    );
  }
  private remember(url: string, subscription: WorkerSubscription): void {
    if (
      !this.state.targets.some(
        (value) =>
          value.url === url &&
          value.id === subscription.listenerId &&
          value.actor.sessionId === subscription.actor.sessionId,
      )
    )
      throw new ArtifactError("Unknown local notification destination");
    this.subscriptions = this.subscriptions.filter(
      (value) =>
        value.url !== url ||
        value.artifactId !== subscription.artifactId ||
        value.mode !== subscription.mode,
    );
    this.subscriptions.push({ ...subscription, url, status: "active" });
  }
  async target(url: string, actor: ArtifactActor, target: ListenerTarget) {
    if (actor.role !== "agent") throw new ArtifactError("Listeners require an agent session");
    let saved = this.state.targets.find(
      (value) => value.url === url && value.actor.sessionId === actor.sessionId,
    );
    if (!saved) {
      saved = { id: randomUUID(), url, actor, target };
    } else saved.target = target;
    // Recent setup may belong to a CLI still preparing a publication. Bound
    // unused destinations by count, without expiring an in-progress command.
    this.state.targets = this.state.targets.filter((value) => value !== saved);
    this.state.targets.push(saved);
    this.prune(url);
    this.save();
    const backend = this.connect(url);
    if (backend.status === "login-required")
      throw new ArtifactError("Backend access is unavailable; run r3 login", 401);
    if (!backend.connectionId || backend.status !== "ready") {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          backend.ready.promise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Worker connection is not ready; check r3 worker status")),
              20_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    }
    if (!backend.connectionId) throw new Error("Worker connection is not ready");
    return { listenerId: saved.id, connectionId: backend.connectionId };
  }
  async reload(url: string): Promise<void> {
    const backend = this.backends.get(url);
    if (!backend) return;
    backend.controller.abort();
    await backend.task;
    this.backends.delete(url);
    this.connect(url);
  }
  status() {
    return {
      workerId: this.state.workerId,
      backends: [...this.backends].map(([url, value]) => ({ url, state: value.status })),
      subscriptions: this.subscriptions.map(({ url, artifactId, mode, status }) => ({
        url,
        artifactId,
        mode,
        status,
      })),
    };
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const backend of this.backends.values()) backend.controller.abort();
    await Promise.all([...this.backends.values()].map((value) => value.task));
  }
}

export async function startWorker(): Promise<void> {
  await withPrivateLock(`${workerInfoPath()}.lock`, async () => {
    const directory = dirname(workerInfoPath());
    privateDirectory(directory);
    const socket = join(directory, "worker.sock");
    if (existsSync(socket)) {
      const stat = lstatSync(socket);
      if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
        throw new Error("Unexpected worker socket");
      rmSync(socket);
    }
    const token = randomBytes(32).toString("base64url");
    const runtime = new WorkerRuntime();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const app = workerApi(runtime, token, stop);
    const server = Bun.serve({
      unix: socket,
      fetch: app.fetch,
      maxRequestBodySize: 32 * 1024,
      development: false,
    });
    chmodSync(socket, 0o600);
    writePrivateJson(workerInfoPath(), { pid: process.pid, socket, token } satisfies WorkerInfo);
    runtime.start();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
      await stopped;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await server.stop(true);
      await runtime.stop();
      rmSync(workerInfoPath(), { force: true });
    }
  });
}

export function workerApi(runtime: WorkerRuntime, token: string, stop: () => void) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const supplied = Buffer.from(c.req.header("x-r3-token") ?? "");
    const expected = Buffer.from(token);
    if (
      c.req.header("origin") !== undefined ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return c.json({ error: "Forbidden" }, 403);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof ArtifactError
            ? error.message
            : "Worker operation failed; check r3 worker status",
      },
      error instanceof ArtifactError ? error.status : 503,
    ),
  );
  app.get("/api/local/status", (c) => c.json(runtime.status()));
  app.post("/api/local/stop", (c) => {
    // Let the HTTP acknowledgment flush before closing the socket.
    setTimeout(stop, 0);
    return c.json({ ok: true });
  });
  app.post("/api/local/target", async (c) => {
    const body = await artifactJson(c.req.raw, 32 * 1024);
    const target = parseListenerTarget(body.target);
    if (!target.ok) throw new ArtifactError(target.error);
    return c.json(
      await runtime.target(
        normalizeBackendUrl(requireString(body.url, "url", 4096)),
        requireActor(body.actor),
        target.target,
      ),
    );
  });
  app.post("/api/local/reload", async (c) => {
    const body = await artifactJson(c.req.raw, 8192);
    await runtime.reload(normalizeBackendUrl(requireString(body.url, "url", 4096)));
    return c.json({ ok: true });
  });
  return app;
}
