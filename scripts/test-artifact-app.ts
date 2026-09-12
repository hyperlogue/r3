import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eventually, openTestBrowser } from "./browser.ts";

// Runs the shipped CLI/daemon/browser together, from a temporary directory that
// contains no source checkout. All discovery, data, and publisher files are isolated.
const root = await mkdtemp(join(tmpdir(), "r3-binary-acceptance-"));
const binary = join(root, "r3");
await copyFile(process.env.R3_TEST_BINARY ?? resolve("r3"), binary);
await chmod(binary, 0o700);
const directory = join(root, "publication");
await mkdir(directory);
const appPort = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const previewPort = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const url = `http://127.0.0.1:${appPort.port}`;
const environment = {
  ...process.env,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  R3_DB: join(root, "store.sqlite"),
  R3_PORT: String(appPort.port),
  R3_PREVIEW_PORT: String(previewPort.port),
  R3_BIND: "127.0.0.1",
  R3_PUBLIC_URL: "",
  R3_PREVIEW_BASE_URL: "",
  R3_ALLOWED_HOSTS: "",
  R3_REQUIRE_LOGIN: "0",
  R3_URL: "",
  R3_TOKEN: "",
  R3_AGENT_SESSION: "binary-publisher",
  R3_DEV: "0",
};
await appPort.stop(true);
await previewPort.stop(true);
const command = async (args: string[], override: Record<string, string> = {}) => {
  const child = Bun.spawn([binary, ...args], {
    cwd: root,
    env: { ...environment, ...override },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, error);
  return output;
};
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><body><h1 id="title">First published page</h1><button id="send">Discuss this heading</button><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{const note=await r3.createFeedback({body:"Please explain the heading",locator:{selector:"#title",quote:title.textContent}});window.createdNote=note.id;};</script></body></html>',
  );
  await writeFile(
    join(directory, "index.md"),
    "# Published Markdown\n\nKept independently of the publisher.\n",
  );
  await writeFile(join(directory, "data.bin"), new Uint8Array([0, 128, 255]));
  const files = JSON.parse(
    await command(["create", "--dir", directory, "--title", "Published files", "--json"]),
  );
  const html = JSON.parse(
    await command([
      "create",
      "--dir",
      directory,
      "--kind",
      "html",
      "--entrypoint",
      "index.html",
      "--title",
      "Published preview",
      "--json",
    ]),
  );
  assert((await command(["status"])).includes("artifacts-v1"));
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.enable");
  await page.command("Runtime.enable");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url });
  await eventually(
    () =>
      page.evaluate(
        "document.body?.textContent.includes('Published files') && document.body?.textContent.includes('Published preview')",
      ),
    "compiled artifact home",
  );
  await page.command("Page.navigate", { url: `${url}/${html.artifact.id}` });
  const content = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.origin.includes(".localhost:") || !context.auxData?.isDefault) continue;
      const frame = page.inContext(context.id);
      try {
        if (await frame.evaluate("!!document.getElementById('send')")) return frame;
      } catch {
        /* Navigation replaced this context. */
      }
    }
    return null;
  }, "compiled isolated preview");
  const offset = await page.evaluate(
    "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const point = await content.evaluate(
    "(()=>{const r=document.querySelector('#send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.command("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      x: offset.x + point.x,
      y: offset.y + point.y,
    });
  const noteId = await eventually(
    () => content.evaluate("window.createdNote"),
    "compiled human utility feedback",
  );
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Please explain the heading')"),
    "compiled conversation panel",
  );
  const detail = JSON.parse(await command(["show", html.artifact.id, "--json"]));
  assert.equal(detail.feedback[0].id, noteId);
  assert.equal(detail.feedback[0].author.role, "human");
  assert.equal(detail.feedback[0].target.versionSeq, 1);
  await writeFile(join(directory, "index.html"), "<!doctype html><h1>Second published page</h1>");
  // A remote publisher has its own discovery directories and explicit server
  // credential; it uploads bytes without exposing any local path to the daemon.
  const announcement = await Bun.file(join(root, "runtime/r3/daemon.json")).json();
  const remote = {
    R3_URL: url,
    R3_TOKEN: announcement.token,
    R3_AGENT_SESSION: "remote-publisher",
    XDG_STATE_HOME: join(root, "publisher-state"),
    XDG_RUNTIME_DIR: join(root, "publisher-runtime"),
    XDG_CONFIG_HOME: join(root, "publisher-config"),
  };
  await command(
    [
      "publish",
      html.artifact.id,
      "--dir",
      directory,
      "--entrypoint",
      "index.html",
      "--expected",
      "1",
      "--key",
      "remote-second",
    ],
    remote,
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Published version\"]')?.options.length===2",
      ),
    "remote publication arrives over SSE",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Published version\"]').value"),
    "1",
  );
  assert.equal(
    await content.evaluate("document.querySelector('h1').textContent"),
    "First published page",
  );
  await rm(directory, { recursive: true });
  assert(
    (
      await command(["source", files.artifact.id, "--version", "1", "--file", "index.md"], remote)
    ).includes("Published Markdown"),
  );
  const bytes = await fetch(
    `${url}/api/artifacts/${files.artifact.id}/versions/1/resource?path=data.bin`,
    { headers: { "x-r3-token": announcement.token } },
  );
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), new Uint8Array([0, 128, 255]));
  const screenshot = await page.command("Page.captureScreenshot", { format: "png" });
  if (process.env.R3_TEST_SCREENSHOT)
    await Bun.write(process.env.R3_TEST_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  console.log(
    "Compiled app: lazy daemon, embedded assets, isolated preview, human utility thread, remote upload, pinned version, offline Markdown and binary reads passed.",
  );
} finally {
  await browser?.close();
  await command(["stop"]);
  await rm(root, { recursive: true, force: true });
}
