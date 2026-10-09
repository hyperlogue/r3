import type { ApplicationAssets } from "./application-assets.ts";
import { createApplicationResponse } from "./application-assets.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactAuthPolicy, artifactRequestHostname } from "./artifact-auth.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { PREVIEW_PREFIX } from "./preview-contexts.ts";
import { PreviewHost } from "./preview-host.ts";
import { previewSupport } from "./preview-support.ts";

export interface ArtifactServerOptions {
  storage: ArtifactStorage;
  assets: ApplicationAssets;
  authentication: ArtifactAuthPolicy;
  bind: string;
  port: number;
}

// The runtime owns the application listener, including scoped preview dispatch.
// It never reads publisher files; the caller owns storage and closes it after stop().
export function startArtifactServer(options: ArtifactServerOptions) {
  if (options.bind === "0.0.0.0" || options.bind === "::" || options.bind === "[::]")
    throw new Error("r3 requires a loopback or explicitly selected interface");
  const previews = new PreviewHost(options.storage.artifacts, previewSupport);
  let api: ReturnType<typeof createArtifactApi> | undefined;
  try {
    // Opaque preview documents send Origin:null. Keep the application's exact
    // origin guard; a shared transport hostname is not a preview principal.
    const addresses = new WeakMap<Request, string>();
    const policy = {
      ...options.authentication,
      peerAddress: (request: Request) => addresses.get(request) ?? null,
    };
    api = createArtifactApi(options.storage, policy, { previews });
    const application = api;
    const assets = createApplicationResponse(options.assets, application.bootstrap);
    const server = Bun.serve({
      hostname: options.bind,
      port: options.port,
      reusePort: false,
      development: false,
      idleTimeout: 120,
      maxRequestBodySize: 200 * 1024 * 1024,
      async fetch(request, server) {
        const address = server.requestIP(request)?.address;
        if (address) addresses.set(request, address);
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
        const path = new URL(request.url).pathname;
        if (path.startsWith(PREVIEW_PREFIX))
          return previews.fetch(request, policy.applicationOrigins);
        if (path.startsWith("/api/")) return application.app.fetch(request);
        return assets(request);
      },
    });
    let stopped = false;
    return {
      server,
      previews,
      api: application,
      async stop() {
        if (stopped) return;
        stopped = true;
        application.close();
        previews.close();
        const draining = server.stop();
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          draining,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
        clearTimeout(timer!);
        await server.stop(true);
      },
    };
  } catch (error) {
    api?.close();
    previews.close();
    throw error;
  }
}
