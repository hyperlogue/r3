import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBootstrap } from "../cli/local-bootstrap.ts";
import { loadApplicationAssets } from "../server/application-assets.ts";
import { startArtifactServer } from "../server/artifact-server.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { LocalBrowserAccess } from "../server/local-access.ts";
import { startLocalBootstrap } from "../server/local-bootstrap.ts";
import { eventually, openTestBrowser } from "./browser.ts";

const root = await mkdtemp(join(tmpdir(), "r3-browser-local-access-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const artifact = storage.artifacts.create({
  kind: "files",
  actor: { role: "human", sessionId: null },
  title: "Private local workspace",
});
const access = new LocalBrowserAccess(storage.authentication);
const server = startArtifactServer({
  storage,
  assets: await loadApplicationAssets({ index: join(import.meta.dir, "../web/index.html") }),
  bind: "127.0.0.1",
  port: 0,
  authentication: {
    token: "private-api-fixture",
    localAccess: access,
    requireLogin: false,
    version: "test",
    allowedHost: (host) => host === "localhost",
  },
});
const url = `http://localhost:${server.server.port}`;
const socket = join(root, "local", "bootstrap.sock");
const bootstrap = startLocalBootstrap({
  socket,
  url,
  publicUrl: url,
  token: "private-api-fixture",
  browser: access,
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.navigate", { url });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Sign in')"),
    "unauthenticated local browser is gated",
  );
  const link = await localBootstrap<{ url: string }>(socket, "browser", {
    path: `/${artifact.id}`,
  });
  await page.command("Page.navigate", { url: link.url });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Private local workspace')"),
    "local ticket opens the workspace",
  );
  assert.equal(await page.evaluate("location.hash"), "");
  assert.equal(await page.evaluate("document.cookie.includes('r3_session')"), false);
  assert.deepEqual(await page.evaluate("fetch('/api/boot').then(r=>r.json())"), {
    needsAuth: false,
    token: null,
  });
  await page.evaluate("fetch('/api/auth/logout',{method:'POST'})");
  await page.command("Page.navigate", { url: link.url });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('already used')"),
    "replayed ticket fails visibly",
  );
  assert.equal(await page.evaluate("location.hash"), "");
  assert.equal(await page.evaluate("fetch('/api/artifacts').then(r=>r.status)"), 401);
  console.log(
    "Local browser setup: private socket, one-use fragment, HttpOnly session, token-free boot, logout and replay rejection passed.",
  );
} finally {
  await browser?.close();
  await bootstrap.stop();
  await server.stop();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
