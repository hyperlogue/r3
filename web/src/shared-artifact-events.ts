import type { ArtifactStreamEvent } from "../../shared/artifacts.ts";

export type ArtifactLiveEvent =
  | Pick<ArtifactStreamEvent, "type" | "artifactId">
  | { type: "ready" }
  | { type: "disconnected" };
type ReadEvents = (signal: AbortSignal) => AsyncIterable<ArtifactStreamEvent | { type: "ready" }>;
type Message =
  | { type: "hello"; sender: string }
  | { type: "event"; event: ArtifactLiveEvent; target?: string };

const subscriptions = new Set<() => void>();

export function stopSharedArtifactEvents(): void {
  for (const stop of subscriptions) stop();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

// Only invalidations cross tabs. Each tab still reads data with its own credentials.
export async function* sharedArtifactEvents(
  read: ReadEvents,
  signal: AbortSignal,
  scope: string,
  isCurrent: () => boolean,
): AsyncGenerator<ArtifactLiveEvent> {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  const queue: ArtifactLiveEvent[] = [];
  let wake = () => {};
  let channel: BroadcastChannel | undefined;
  let election: AbortController | undefined;
  let leading = false;
  let connected = false;
  let polling = false;
  const name = `r3-artifact-events-v1:${scope}`;
  const id = crypto.randomUUID?.() ?? String(Math.random());
  const current = () => !lifetime.signal.aborted && isCurrent();
  const visible = () => document.visibilityState !== "hidden";
  const emit = (event: ArtifactLiveEvent) => {
    if (!current()) return;
    // A resumed or slow tab needs a snapshot, not an unbounded invalidation backlog.
    if (queue.length >= 128) queue.splice(0, queue.length, { type: "ready" });
    else queue.push(event);
    wake();
  };
  const broadcast = (event: ArtifactLiveEvent) => {
    if (!current()) return;
    const notification =
      "artifactId" in event ? { type: event.type, artifactId: event.artifactId } : event;
    channel?.postMessage({ type: "event", event: notification } satisfies Message);
    emit(notification);
  };
  const poll = () => {
    if (!visible()) return;
    emit({ type: "ready" });
    emit({ type: "disconnected" });
  };
  const elect = () => {
    if (polling || election || !visible() || !current()) return;
    const candidate = new AbortController();
    election = candidate;
    void navigator.locks
      .request(name, { signal: candidate.signal }, async () => {
        leading = true;
        let delay = 500;
        try {
          while (!candidate.signal.aborted && current()) {
            try {
              for await (const event of read(candidate.signal)) {
                if (candidate.signal.aborted || !current()) break;
                connected = true;
                delay = 500;
                broadcast(event);
              }
            } catch {
              // Reconnects announce ready so every tab recovers missed invalidations.
            }
            connected = false;
            broadcast({ type: "disconnected" });
            if (candidate.signal.aborted || !current()) break;
            await wait(delay, candidate.signal);
            delay = Math.min(8000, delay * 2);
          }
        } finally {
          leading = false;
          connected = false;
        }
      })
      .catch(() => {
        if (!candidate.signal.aborted && current()) {
          polling = true;
          poll();
        }
      })
      .finally(() => {
        if (election === candidate) election = undefined;
        // Visibility can return while cancellation is still releasing the lock.
        if (candidate.signal.aborted) elect();
      });
  };
  const check = () => {
    if (!current()) stop();
  };
  const visibility = () => {
    check();
    if (!visible()) {
      election?.abort();
      queue.length = 0;
      return;
    }
    if (polling) poll();
    else {
      emit({ type: "ready" });
      channel?.postMessage({ type: "hello", sender: id } satisfies Message);
      elect();
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  lifetime.signal.addEventListener("abort", () => {
    election?.abort();
    wake();
  });
  subscriptions.add(stop);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    if (signal.aborted || !isCurrent()) return;
    if (typeof BroadcastChannel !== "undefined" && navigator.locks) {
      try {
        channel = new BroadcastChannel(name);
        channel.onmessage = ({ data }: MessageEvent<Message>) => {
          check();
          if (!current()) return;
          if (data?.type === "hello" && leading && connected) {
            channel!.postMessage({
              type: "event",
              event: { type: "ready" },
              target: data.sender,
            } satisfies Message);
          } else if (data?.type === "event" && (!data.target || data.target === id)) {
            emit(data.event);
          }
        };
      } catch {
        polling = true;
      }
    } else polling = true;
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", stop);
    window.addEventListener("storage", check);
    timer = setInterval(() => {
      check();
      if (polling) poll();
    }, 15_000);
    visibility();
    while (current()) {
      if (!queue.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (!current() || queue.length) resolve();
        });
      while (current() && queue.length) yield queue.shift()!;
    }
  } finally {
    stop();
    subscriptions.delete(stop);
    clearInterval(timer);
    channel?.close();
    signal.removeEventListener("abort", stop);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", stop);
    window.removeEventListener("storage", check);
  }
}
