import { dirname, join } from "node:path";
import { BackendCredentials } from "../cli/backend.ts";
import { writePrivateJson } from "../cli/private-state.ts";
import { ensureWorker } from "../cli/worker-client.ts";
import type { WorkerImport } from "../cli/worker-runtime.ts";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import index from "../web/index.html";
import { loadApplicationAssets } from "./application-assets.ts";
import { artifactAuthSettings, artifactProjectSettings } from "./artifact-config.ts";
import { startArtifactServer } from "./artifact-server.ts";
import { openArtifactStorage } from "./artifact-storage.ts";
import {
  acquireDaemonLock,
  BIND,
  daemonJsonPath,
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
  stateDir,
  writeDaemonJson,
} from "./config.ts";
import { LocalBrowserAccess } from "./local-access.ts";
import { startLocalBootstrap } from "./local-bootstrap.ts";

// Migration occurs only after this process holds the per-user daemon lock.
// Importing the CLI/server opens no database.
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
  let bootstrap: ReturnType<typeof startLocalBootstrap> | undefined;
  try {
    const assets = await loadApplicationAssets(index);
    storage = await openArtifactStorage({
      databasePath: stateDbPath(),
      projectGrouping: artifactProjectSettings(process.env, readConfig()),
      ...artifactAuthSettings(process.env, readConfig()),
      archiveTtlDays: readConfig().archiveTtlDays,
    });
    const token = getToken();
    const localAccess = new LocalBrowserAccess(storage.authentication);
    const bootstrapSocket = join(dirname(daemonJsonPath()), "server", "bootstrap.sock");
    runtime = startArtifactServer({
      storage,
      assets,
      bind: BIND,
      port: PORT,
      authentication: {
        token,
        localAccess,
        requireLogin: REQUIRE_LOGIN,
        version: R3_VERSION,
        allowedHost: isAllowedHost,
        applicationOrigins: new Set([new URL(PUBLIC_URL).origin]),
        publicUrl: normalizeBackendUrl(PUBLIC_URL),
        trustedProxies: new Set(readConfig().trustedProxies ?? []),
      },
    });
    bootstrap = startLocalBootstrap({
      socket: bootstrapSocket,
      url: LOCAL_URL,
      publicUrl: PUBLIC_URL,
      token,
      browser: localAccess,
    });
    writeDaemonJson({
      url: LOCAL_URL,
      port: PORT,
      pid: process.pid,
      bootstrapSocket,
      version: R3_VERSION,
      protocol: "artifacts-v2",
      publicUrl: PUBLIC_URL,
      requireLogin: REQUIRE_LOGIN,
      exec: process.execPath,
      argv: process.argv,
    });
    const legacy = storage.listeners.exportLocal();
    if (legacy.length) {
      try {
        await new BackendCredentials().save({
          url: normalizeBackendUrl(LOCAL_URL),
          kind: "key",
          accessToken: token,
        });
        writePrivateJson(join(stateDir(), "worker-import.json"), {
          url: LOCAL_URL,
          listeners: legacy,
        } satisfies WorkerImport);
        await ensureWorker();
      } catch {
        console.error("r3: saved listeners need worker setup; run r3 worker start to retry");
      }
    }
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await bootstrap!.stop();
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
        "r3: artifact schema upgraded; its database backup is retained in artifact storage",
      );
  } catch (error) {
    await bootstrap?.stop();
    await runtime?.stop();
    storage?.close();
    if (readDaemonJson()?.pid === process.pid) removeDaemonJson();
    releaseDaemonLock();
    throw error;
  }
}

if (import.meta.main) await startArtifactDaemon();
