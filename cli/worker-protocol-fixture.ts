// An independent backend fixture: deliberately imports no r3 contracts, server,
// database, or delivery implementation. Compatibility is exercised over HTTP.
export class WorkerProtocolFixture {
  destinationSnapshot = true;
  readonly backends = new Map<
    string,
    {
      token: string;
      connects: number;
      subscriptions: Map<string, Record<string, unknown>>;
      requests: string[];
      stream?: ReadableStreamDefaultController<Uint8Array>;
      acknowledgments: Record<string, unknown>[];
    }
  >();
  add(url: string, token: string): void {
    this.backends.set(url, {
      token,
      connects: 0,
      subscriptions: new Map(),
      requests: [],
      acknowledgments: [],
    });
  }
  send(url: string, event: unknown): void {
    const message = event as {
      type: string;
      subscription?: Record<string, unknown>;
      registrationId?: string;
    };
    if (message.type === "registered" && message.subscription)
      this.backends
        .get(url)!
        .subscriptions.set(String(message.subscription.id), message.subscription);
    if (message.type === "retired")
      this.backends.get(url)!.subscriptions.delete(message.registrationId!);
    this.backends
      .get(url)!
      .stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  }
  disconnect(url: string): void {
    this.backends.get(url)!.stream?.close();
  }
  fetch = async (request: Request): Promise<Response> => {
    const url = [...this.backends.keys()].find((value) => request.url.startsWith(`${value}/api/`));
    if (!url) return Response.json({ error: "Unknown backend" }, { status: 404 });
    const backend = this.backends.get(url)!;
    if (request.headers.get("x-r3-token") !== backend.token)
      return Response.json({ error: "Authentication required" }, { status: 401 });
    const path = request.url.slice(url.length);
    backend.requests.push(path);
    const body = (await request.json()) as Record<string, unknown>;
    if (path === "/api/workers/connect") {
      if (body.protocol !== "r3-worker-v2")
        return Response.json({ error: "Protocol mismatch" }, { status: 409 });
      backend.connects++;
      let abort = () => {};
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            backend.stream = controller;
            abort = () => {
              try {
                controller.error(new DOMException("Aborted", "AbortError"));
              } catch {
                /* Stream already closed. */
              }
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.send(url, {
              type: "ready",
              protocol: "r3-worker-v2",
              connectionId: `connection-${backend.connects}`,
              listenerIds: this.destinationSnapshot
                ? [...new Set([...backend.subscriptions.values()].map((value) => value.listenerId))]
                : undefined,
            });
            for (const subscription of backend.subscriptions.values())
              this.send(url, {
                type: "registered",
                subscription,
                registration: { id: subscription.id },
              });
          },
          cancel: () => request.signal.removeEventListener("abort", abort),
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (
      path !== "/api/sessions" &&
      !path.endsWith("/targets") &&
      !path.endsWith("/acknowledgments")
    )
      return Response.json({ error: "Unknown route" }, { status: 404 });
    if (path.endsWith("/acknowledgments")) backend.acknowledgments.push(body);
    return Response.json({ ok: true });
  };
}
