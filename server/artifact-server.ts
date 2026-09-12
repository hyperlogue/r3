import type { ApplicationAssets } from "./application-assets.ts";
import { applicationAssetResponse } from "./application-assets.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactAuthPolicy, artifactRequestHostname } from "./artifact-auth.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { PreviewHost } from "./preview-host.ts";
import { previewSupport } from "./preview-support.ts";

export interface ArtifactServerOptions {
  storage: ArtifactStorage;
  assets: ApplicationAssets;
  authentication: ArtifactAuthPolicy;
  bind: string;
  port: number;
  previewPort: number;
  previewBaseUrl?: string;
}

// The runtime owns two listeners and their live connections. Neither listener
// reads publisher files; the caller owns storage and closes it after stop().
export function startArtifactServer(options: ArtifactServerOptions) {
  if (options.bind === "0.0.0.0" || options.bind === "::" || options.bind === "[::]")
    throw new Error("r3 requires a loopback or explicitly selected interface");
  let previews: PreviewHost;
  const previewServer = Bun.serve({
    hostname: "127.0.0.1",
    port: options.previewPort,
    reusePort: false,
    development: false,
    idleTimeout: 120,
    maxRequestBodySize: 4096,
    fetch: (request) => previews.fetch(request),
  });
  let api: ReturnType<typeof createArtifactApi> | undefined;
  try {
    previews = new PreviewHost(
      options.storage.artifacts,
      options.previewBaseUrl ?? `http://localhost:${previewServer.port}`,
      previewSupport,
    );
    // Opaque preview documents send Origin:null. Keep the application's exact
    // origin guard; a shared transport hostname is not a preview principal.
    const policy = options.authentication;
    api = createArtifactApi(options.storage, policy, { previews });
    const application = api;
    const server = Bun.serve({
      hostname: options.bind,
      port: options.port,
      reusePort: false,
      development: false,
      idleTimeout: 120,
      maxRequestBodySize: 200 * 1024 * 1024,
      async fetch(request) {
        const hostname = artifactRequestHostname(request);
        if (hostname === null || !policy.allowedHost(hostname))
          return new Response("Forbidden host", {
            status: 403,
            headers: {
              "content-type": "text/plain",
              "cache-control": "no-store",
              "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
            },
          });
        if (new URL(request.url).pathname.startsWith("/api/"))
          return application.app.fetch(request);
        return applicationAssetResponse(options.assets, request);
      },
    });
    let stopped = false;
    return {
      server,
      previewServer,
      previews,
      api: application,
      async stop() {
        if (stopped) return;
        stopped = true;
        application.close();
        previews.close();
        const draining = Promise.all([server.stop(), previewServer.stop()]);
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          draining,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
        clearTimeout(timer!);
        await Promise.all([server.stop(true), previewServer.stop(true)]);
      },
    };
  } catch (error) {
    api?.close();
    void previewServer.stop(true);
    throw error;
  }
}
