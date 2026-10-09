import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApplicationAssets } from "../server/application-assets.ts";
import { startArtifactServer } from "../server/artifact-server.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import index from "../web/index.html";
import { eventually, openTestBrowser } from "./browser.ts";

const root = await mkdtemp(join(tmpdir(), "r3-login-browser-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const token = randomBytes(32).toString("hex");
const runtime = startArtifactServer({
  storage,
  assets: await loadApplicationAssets(index),
  bind: "127.0.0.1",
  port: 0,
  authentication: {
    token,
    requireLogin: true,
    version: "fixture",
    allowedHost: (host) => host === "localhost",
  },
});
const url = `http://localhost:${runtime.server.port}`;
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  const login = storage.authentication.createLoginToken(null);
  await page.command("Page.navigate", { url });
  await eventually(() => page.evaluate("!!document.querySelector('input')"), "browser login");
  assert.equal(
    await page.evaluate(
      `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(login.token)}})}).then(r=>r.status)`,
    ),
    200,
  );
  for (const approved of [true, false]) {
    const response = await fetch(`${url}/api/oauth/device/code`, {
      method: "POST",
      body: new URLSearchParams({ client_id: "r3-cli", label: "Browser acceptance" }),
    });
    assert.equal(response.status, 200);
    const device = await response.json();
    await page.command("Page.navigate", { url: device.verification_uri_complete });
    await eventually(
      () => page.evaluate("document.querySelector('#approval-code')?.value"),
      "CLI code entry",
    );
    assert.equal(
      await page.evaluate("document.querySelector('#approval-code').value"),
      device.user_code,
    );
    await page.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='Review request').click()",
    );
    await eventually(
      () => page.evaluate("document.body.textContent.includes('Requested from')"),
      "reviewed request address",
    );
    assert.equal(
      (storage.clientAuth.auditLog() as { event: string }[]).some(
        (row) => row.event === "approved",
      ),
      !approved,
    );
    await page.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(approved ? "Approve CLI access" : "Decline")}).click()`,
    );
    await eventually(
      () =>
        page.evaluate(
          `document.querySelector('[role="status"]')?.textContent.includes(${JSON.stringify(approved ? "approved" : "declined")})`,
        ),
      "explicit decision",
    );
    assert.equal(
      await page.evaluate(
        `document.documentElement.outerHTML.includes(${JSON.stringify(device.device_code)})`,
      ),
      false,
    );
    const flow = storage.clientAuth.inspect.bind(storage.clientAuth, device.user_code);
    assert.throws(flow);
  }
  assert.equal(
    (storage.clientAuth.auditLog() as { event: string }[]).filter((row) => row.event === "approved")
      .length,
    1,
  );
  console.log(
    "Client login browser acceptance: authenticated review, explicit approve/decline, and no device secret in the document passed",
  );
} finally {
  await browser?.close();
  await runtime.stop();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
