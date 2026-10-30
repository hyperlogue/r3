import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBootstrap } from "../cli/local-bootstrap.ts";
import { loadApplicationAssets } from "../server/application-assets.ts";
import { startArtifactServer } from "../server/artifact-server.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { startLocalBootstrap } from "../server/local-bootstrap.ts";
import { eventually, openTestBrowser } from "./browser.ts";

for (const requireLogin of [false, true]) {
  const root = await mkdtemp(join(tmpdir(), "r3-browser-local-access-"));
  const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  const artifact = storage.artifacts.create({
    kind: "files",
    actor: { role: "human", sessionId: null },
    title: "Private local workspace",
  });
  const server = startArtifactServer({
    storage,
    assets: await loadApplicationAssets({ index: join(import.meta.dir, "../web/index.html") }),
    bind: "127.0.0.1",
    port: 0,
    authentication: {
      token: "private-api-fixture",
      requireLogin,
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
  });
  let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
  try {
    browser = await openTestBrowser();
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const page = await browser.attach(targetId);
    await page.command("Page.navigate", { url: `${url}/${artifact.id}` });
    if (requireLogin) {
      await eventually(
        () => page.evaluate("document.body.textContent.includes('Sign in')"),
        "protected local browser is gated",
      );
    } else {
      await eventually(
        () => page.evaluate("document.body.textContent.includes('Private local workspace')"),
        "localhost workspace opens without sign-in",
      );
      // The first visit explains the no-login trade-off once per browser.
      await eventually(
        () => page.evaluate("!!document.querySelector('dialog[data-login-disabled-notice][open]')"),
        "no-login notice appears on the first visit",
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('dialog[data-login-disabled-notice] a').href.endsWith('/docs/access/')",
        ),
        true,
      );
      await page.evaluate(
        "[...document.querySelectorAll('dialog[data-login-disabled-notice] button')].at(-1).click()",
      );
      await eventually(
        () => page.evaluate("!document.querySelector('dialog[data-login-disabled-notice]')"),
        "no-login notice closes",
      );
    }
    const link = await localBootstrap<{ url: string }>(socket, "browser", {
      path: `/${artifact.id}`,
    });
    assert.equal(link.url, `${url}/${artifact.id}`);
    await page.command("Page.navigate", { url: "about:blank" });
    await page.command("Page.navigate", { url: link.url });
    if (requireLogin) {
      await eventually(
        () => page.evaluate("document.body.textContent.includes('Sign in')"),
        "opening the ordinary URL preserves required login",
      );
      assert.equal(storage.authentication.listTokens().length, 0);
      const login = storage.authentication.createLoginToken("Browser acceptance");
      assert.equal(
        await page.evaluate(`fetch('/api/auth/login', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({token: ${JSON.stringify(login.token)}})
        }).then(r => r.status)`),
        200,
      );
      await page.command("Page.navigate", { url: "about:blank" });
      await page.command("Page.navigate", { url: link.url });
    }
    await eventually(
      () => page.evaluate("document.body.textContent.includes('Private local workspace')"),
      "ordinary URL opens the workspace with the configured login policy",
    );
    if (requireLogin)
      assert.equal(
        await page.evaluate("!!document.querySelector('dialog[data-login-disabled-notice]')"),
        false,
      );
    assert.equal(await page.evaluate("location.hash"), "");
    assert.equal(await page.evaluate("document.cookie.includes('r3_session')"), false);
    assert.deepEqual(await page.evaluate("fetch('/api/boot').then(r=>r.json())"), {
      needsAuth: false,
      token: null,
      loginRequired: requireLogin,
    });
    if (requireLogin) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.command("Page.navigate", { url: "about:blank" });
        await page.command("Page.navigate", { url: link.url });
        await eventually(
          () => page.evaluate("document.body.textContent.includes('Private local workspace')"),
          "reopening retains the existing browser session",
        );
      }
      const records = new Database(join(root, "store.sqlite"), { readonly: true });
      try {
        assert.deepEqual(records.query("SELECT COUNT(*) AS n FROM auth_tokens").get(), { n: 1 });
        assert.deepEqual(records.query("SELECT COUNT(*) AS n FROM auth_sessions").get(), { n: 1 });
      } finally {
        records.close();
      }
      await page.evaluate("fetch('/api/auth/logout',{method:'POST'})");
      await page.command("Page.navigate", { url: "about:blank" });
      await page.command("Page.navigate", { url: link.url });
      await eventually(
        () => page.evaluate("document.body.textContent.includes('Sign in')"),
        "opening after logout requires normal sign-in",
      );
      assert.equal(await page.evaluate("location.hash"), "");
      assert.equal(await page.evaluate("fetch('/api/artifacts').then(r=>r.status)"), 401);
    } else {
      await page.command("Page.navigate", { url: "about:blank" });
      await page.command("Page.navigate", { url: link.url });
      await eventually(
        () => page.evaluate("document.body.textContent.includes('Private local workspace')"),
        "ordinary URL can be reopened without a ticket",
      );
      assert.equal(
        await page.evaluate("!!document.querySelector('dialog[data-login-disabled-notice]')"),
        false,
      );
      assert.equal(await page.evaluate("fetch('/api/artifacts').then(r=>r.status)"), 200);
      const records = new Database(join(root, "store.sqlite"), { readonly: true });
      try {
        assert.deepEqual(records.query("SELECT COUNT(*) AS n FROM auth_tokens").get(), { n: 0 });
        assert.deepEqual(records.query("SELECT COUNT(*) AS n FROM auth_sessions").get(), { n: 0 });
      } finally {
        records.close();
      }
    }
    console.log(`Local browser setup passed with requireLogin=${requireLogin}`);
  } finally {
    await browser?.close();
    await bootstrap.stop();
    await server.stop();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}
