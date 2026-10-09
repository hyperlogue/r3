// An independent backend fixture: deliberately imports no r3 contracts, server,
// database, or delivery implementation. Compatibility is exercised over HTTP.
export class WorkerProtocolFixture {
  readonly backends = new Map<
    string,
    {
      token: string;
      connects: number;
      resumes: number;
      conflict: boolean;
      stream?: ReadableStreamDefaultController<Uint8Array>;
      acknowledgments: Record<string, unknown>[];
    }
  >();
  add(url: string, token: string): void {
    this.backends.set(url, {
      token,
      connects: 0,
      resumes: 0,
      conflict: false,
      acknowledgments: [],
    });
  }
  send(url: string, event: unknown): void {
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
    const body = (await request.json()) as Record<string, unknown>;
    if (path === "/api/workers/connect") {
      if (body.protocol !== "r3-worker-v1")
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
              protocol: "r3-worker-v1",
              connectionId: `connection-${backend.connects}`,
            });
          },
          cancel: () => request.signal.removeEventListener("abort", abort),
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (path.endsWith("/resume")) {
      backend.resumes++;
      if (backend.conflict)
        return Response.json({ error: "Artifact already has a recipient" }, { status: 409 });
      for (const subscription of body.subscriptions as Record<string, unknown>[])
        this.send(url, { type: "registered", subscription, registration: { id: subscription.id } });
    }
    if (path.endsWith("/acknowledgments")) backend.acknowledgments.push(body);
    return Response.json({ ok: true });
  };
}
