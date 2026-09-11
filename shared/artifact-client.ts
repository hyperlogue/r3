export class ArtifactApiError extends Error {
  constructor(
    readonly status: number,
    readonly result: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactApiError";
  }
}

export interface ArtifactClientOptions {
  url: string;
  token?: string;
  fetch?: (request: Request) => Promise<Response>;
}

// The publisher and browser speak the same API. Redirects are forbidden so an
// upload or authenticated request cannot silently move to a different origin.
export class ArtifactClient {
  readonly url: string;
  private readonly send: (request: Request) => Promise<Response>;
  constructor(private readonly options: ArtifactClientOptions) {
    const url = new URL(options.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "r3 URL must be an HTTP(S) application URL without credentials, query, or fragment",
      );
    this.url = url.href.replace(/\/+$/, "");
    this.send = options.fetch ?? ((request) => fetch(request));
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!path.startsWith("/api/") || path.includes("#"))
      throw new Error("Invalid artifact API path");
    const headers = new Headers();
    if (this.options.token) headers.set("x-r3-token", this.options.token);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.send(
      new Request(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(180_000),
      }),
    );
    if (response.ok) return response;
    const result: unknown = await response.json().catch(() => null);
    const object = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const notification = object.notification as { state?: string; error?: string } | undefined;
    const message =
      typeof object.error === "string"
        ? object.error
        : notification?.state === "failed"
          ? notification.error
          : undefined;
    throw new ArtifactApiError(
      response.status,
      result,
      message ?? `r3 request failed (${response.status})`,
    );
  }

  async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await this.request(method, path, body, signal)).json() as Promise<T>;
  }

  async checkProtocol(): Promise<void> {
    const health = await this.json<{ protocol?: string }>("GET", "/api/health");
    if (health.protocol !== "artifacts-v1")
      throw new Error(
        "This server uses the previous review protocol. Upgrade and restart r3 before publishing artifacts.",
      );
  }
}

export const artifactApiPath = (id: string) => `/api/artifacts/${encodeURIComponent(id)}`;
export const feedbackApiPath = (id: string) => `/api/feedback/${encodeURIComponent(id)}`;
