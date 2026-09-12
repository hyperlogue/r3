import index from "../web/index.html";
import { loadApplicationAssets } from "./application-assets.ts";
import { artifactPreviewSettings } from "./artifact-config.ts";
import { startArtifactServer } from "./artifact-server.ts";
import { openArtifactStorage } from "./artifact-storage.ts";
import {
  acquireDaemonLock,
  BIND,
  getToken,
  isAllowedHost,
  LOCAL_URL,
  PORT,
  PUBLIC_URL,
  R3_VERSION,
  REQUIRE_LOGIN,
  readConfig,
  readDaemonJson,
  releaseDaemonLock,
  removeDaemonJson,
  stateDbPath,
  writeDaemonJson,
} from "./config.ts";

// Migration occurs only after this process holds the per-user daemon lock.
// Importing the CLI/server opens no legacy or artifact database.
export async function startArtifactDaemon(): Promise<void> {
  if (!acquireDaemonLock()) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const existing = readDaemonJson();
      if (existing && existing.pid !== process.pid) {
        try {
          if ((await fetch(`${existing.url}/api/health`, { signal: AbortSignal.timeout(500) })).ok)
            return;
        } catch {
          /* Another start may still be migrating or binding. */
        }
      }
      await Bun.sleep(50);
    }
    return;
  }
  let storage: Awaited<ReturnType<typeof openArtifactStorage>> | undefined;
  let runtime: ReturnType<typeof startArtifactServer> | undefined;
  try {
    const settings = artifactPreviewSettings(process.env, readConfig(), PORT);
    const assets = await loadApplicationAssets(index);
    storage = await openArtifactStorage({ databasePath: stateDbPath() });
    const token = getToken();
    runtime = startArtifactServer({
      storage,
      assets,
      bind: BIND,
      port: PORT,
      previewPort: settings.port,
      previewBaseUrl: settings.baseUrl,
      authentication: {
        token,
        requireLogin: REQUIRE_LOGIN,
        version: R3_VERSION,
        allowedHost: isAllowedHost,
        applicationOrigins: new Set([new URL(PUBLIC_URL).origin]),
      },
    });
    writeDaemonJson({
      url: LOCAL_URL,
      port: PORT,
      pid: process.pid,
      token,
      version: R3_VERSION,
      protocol: "artifacts-v1",
      publicUrl: PUBLIC_URL,
      previewBaseUrl: settings.baseUrl ?? PUBLIC_URL,
      requireLogin: REQUIRE_LOGIN,
      exec: process.execPath,
      argv: process.argv,
    });
    const authentication = storage.authentication;
    const sweep = setInterval(
      () => {
        try {
          authentication.expireSessions();
        } catch {
          console.error("r3: session housekeeping failed");
        }
      },
      6 * 60 * 60_000,
    );
    sweep.unref();
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      clearInterval(sweep);
      await runtime!.stop();
      storage!.close();
      if (readDaemonJson()?.pid === process.pid) removeDaemonJson();
      releaseDaemonLock();
      process.exit(0);
    };
    process.on("SIGTERM", () => {
      void shutdown();
    });
    process.on("SIGINT", () => {
      if (process.env.R3_DETACHED !== "1") void shutdown();
    });
    process.on("SIGHUP", () => {});
    process.on("unhandledRejection", () => console.error("r3: a background operation failed"));
    console.log(`r3 artifact daemon on ${PUBLIC_URL}/ (v${R3_VERSION})`);
    if (storage.migration?.migrated)
      console.log(
        "r3: previous reviews imported; their database backup is retained in artifact storage",
      );
  } catch (error) {
    await runtime?.stop();
    storage?.close();
    if (readDaemonJson()?.pid === process.pid) removeDaemonJson();
    releaseDaemonLock();
    throw error;
  }
}

if (import.meta.main) await startArtifactDaemon();
