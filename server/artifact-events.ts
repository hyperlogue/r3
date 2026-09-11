import type { ArtifactCollaboration } from "./artifact-collaboration.ts";

export const ARTIFACT_EVENT_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
};

// Events are invalidations, not durable receipts. A reconnect starts with ready
// and the client refetches current state. Slow readers disconnect before their
// queue can grow without bound; they use that same reconnect/refetch path.
export function artifactEvents(
  collaboration: ArtifactCollaboration,
  signal: AbortSignal,
  artifactId?: string,
) {
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setInterval>;
      close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(timer);
        signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* Already cancelled. */
        }
      };
      const send = (event: string, value: unknown) => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < -128) {
          close();
          return;
        }
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
          );
        } catch {
          close();
        }
      };
      unsubscribe = collaboration.subscribe((event) => {
        if (!artifactId || event.artifactId === artifactId) send(event.type, event);
      });
      send("ready", {});
      timer = setInterval(() => send("heartbeat", {}), 20_000);
      timer.unref();
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, { headers: ARTIFACT_EVENT_HEADERS });
}
