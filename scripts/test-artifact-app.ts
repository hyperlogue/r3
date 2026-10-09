import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactConversations } from "../server/artifact-conversations.ts";
import { renderArtifactDocument } from "../server/artifact-document.ts";
import { createArtifactTables } from "../server/artifact-schema.ts";
import { ArtifactStore } from "../server/artifacts.ts";
import { BlobStore } from "../server/blobs.ts";
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
const url = `http://127.0.0.1:${appPort.port}`;
const environment = {
  ...process.env,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  R3_DB: join(root, "store.sqlite"),
  R3_PORT: String(appPort.port),
  R3_BIND: "127.0.0.1",
  R3_PUBLIC_URL: "",
  R3_ALLOWED_HOSTS: "",
  R3_REQUIRE_LOGIN: "0",
  R3_URL: "",
  R3_TOKEN: "",
  R3_AGENT_SESSION: "binary-publisher",
  CODEX_THREAD_ID: "",
  CODEX_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CLAUDE_CODE_MESSAGING_SOCKET: "",
  CLAUDE_CODE_MESSAGING_TOKEN: "",
  R3_DEV: "0",
};
await appPort.stop(true);
const command = async (args: string[], override: Record<string, string> = {}, input?: string) => {
  const child = Bun.spawn([binary, ...args], {
    cwd: root,
    env: { ...environment, ...override },
    stdin: input === undefined ? "ignore" : new Blob([input]),
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
  // Already-imported history remains readable. Seed an older artifact schema
  // before starting the isolated daemon so the compiled binary performs its upgrade.
  const previous = new Database(environment.R3_DB);
  createArtifactTables(previous);
  const time = "2026-09-01T00:00:00.000Z";
  previous
    .query(`INSERT INTO artifacts
    (id, kind, title, created_by, next_seq, created_at, updated_at, legacy_json)
    VALUES ('review_imported', 'files', 'Imported publication', 'human', 2, ?, ?, '{}')`)
    .run(time, time);
  const store = new ArtifactStore(
    previous,
    new BlobStore(join(`${environment.R3_DB}.artifacts`, "blobs")),
    renderArtifactDocument,
    () => time,
  );
  const human = { role: "human" as const, sessionId: null };
  await store.publish("review_imported", {
    actor: human,
    expectedSeq: 0,
    publicationKey: "retained",
    content: {
      kind: "files",
      files: [
        {
          path: "index.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Retained legacy content").toString("base64"),
        },
      ],
    },
  });
  const conversations = new ArtifactConversations(previous, store, () => time);
  const retainedNote = await conversations.add("review_imported", {
    actor: human,
    body: "Retained human note",
    target: { kind: "artifact" },
  });
  store.registerSession({ id: "imported-agent", label: "Imported agent" });
  const retainedComment = await conversations.addComment(retainedNote.id, {
    actor: { role: "agent", sessionId: "imported-agent" },
    body: "Retained agent comment",
    context: { versionSeq: 2, representation: "source" },
  });
  previous.exec("PRAGMA user_version = 8");
  previous.close();
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><body><h1 id="title">First published page</h1><button id="send">Discuss this heading</button><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{const note=await r3.createDiscussion({body:"Please explain the heading",locator:{selector:"#title",quote:title.textContent}});window.createdNote=note.id;};</script></body></html>',
  );
  await writeFile(
    join(directory, "index.md"),
    "# Published Markdown\n\nKept independently of the publisher.\n",
  );
  await writeFile(join(directory, "data.bin"), new Uint8Array([0, 128, 255]));
  const files = JSON.parse(
    await command([
      "create",
      "--kind",
      "files",
      "--dir",
      directory,
      "--title",
      "Published files",
      "--json",
    ]),
  );
  const html = JSON.parse(
    await command([
      "create",
      "--dir",
      directory,
      "--kind",
      "html",
      "--file",
      "index.html",
      "--title",
      "Published preview",
      "--json",
    ]),
  );
  assert((await command(["status"])).includes("artifacts-v2"));
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  const frames = new Map<string, Awaited<ReturnType<typeof browser.attach>>>();
  const renderedFrame = async (expression: string) => {
    for (const context of page.contexts.values()) {
      if (context.origin !== "://" || !context.auxData?.isDefault) continue;
      const frame = page.inContext(context.id);
      try {
        if (await frame.evaluate(expression)) return frame;
      } catch {
        /* Navigating. */
      }
    }
    for (const target of (await browser!.send("Target.getTargets")).targetInfos) {
      if (target.type !== "iframe" || !target.url.includes("/__r3_preview/")) continue;
      try {
        let frame = frames.get(target.targetId);
        if (!frame) {
          frame = await browser!.attach(target.targetId);
          frames.set(target.targetId, frame);
        }
        if (await frame.evaluate(expression)) return frame;
      } catch {
        /* Navigation replaced this isolated frame. */
      }
    }
    return null;
  };
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
  await page.command("Page.navigate", { url: `${url}/review_imported` });
  if (process.env.R3_TEST_COMPATIBLE === "1") {
    await eventually(
      () =>
        page.evaluate(
          "[...document.querySelectorAll('button')].some(button=>button.textContent==='Accept risk and continue')",
        ),
      "explicit browser compatibility consent",
    );
    await page.evaluate(
      "[...document.querySelectorAll('button')].find(button=>button.textContent==='Accept risk and continue').click()",
    );
  }
  await eventually(async () => {
    if (
      !(await page.evaluate(
        "document.body?.textContent.includes('Retained human note') && document.body?.textContent.includes('Retained agent comment')",
      ))
    )
      return false;
    return !!(await renderedFrame(
      "document.body?.textContent.includes('Retained legacy content')",
    ));
  }, "preserved review URL, rendered Markdown, and migrated conversation");
  const imported = JSON.parse(await command(["show", "review_imported", "--json"]));
  assert.deepEqual(
    imported.versions.map((version: { seq: number }) => version.seq),
    [2],
  );
  assert.equal(imported.discussions[0].comments[0].id, retainedComment.id);
  assert.equal(imported.discussions[0].comments[0].sentAt, null);
  const backups = await readdir(`${environment.R3_DB}.artifacts/backups`);
  assert.equal(backups.length, 1);
  const backup = new Database(join(`${environment.R3_DB}.artifacts/backups`, backups[0]), {
    readonly: true,
  });
  assert.deepEqual(backup.query("PRAGMA user_version").get(), { user_version: 8 });
  assert.deepEqual(backup.query("SELECT id FROM artifacts").all(), [{ id: "review_imported" }]);
  backup.close();
  await page.command("Page.navigate", { url: `${url}/${html.artifact.id}` });
  const content = await eventually(
    () => renderedFrame("!!document.getElementById('send')"),
    "compiled isolated preview",
  );
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
    "compiled human utility discussions",
  );
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Please explain the heading')"),
    "compiled conversation panel",
  );
  const detail = JSON.parse(await command(["show", html.artifact.id, "--json"]));
  assert.equal(detail.discussions[0].id, noteId);
  assert.equal(detail.discussions[0].comments[0].author.role, "human");
  assert.equal(detail.discussions[0].target.versionSeq, 1);
  await writeFile(join(directory, "index.html"), "<!doctype html><h1>Second published page</h1>");
  // A remote publisher has its own discovery directories and explicit server
  // credential; it uploads bytes without exposing any local path to the daemon.
  const announcement = await Bun.file(join(root, "runtime/r3/daemon.json")).json();
  const remote = {
    R3_URL: url,

    R3_AGENT_SESSION: "remote-publisher",
    XDG_STATE_HOME: join(root, "publisher-state"),
    XDG_RUNTIME_DIR: join(root, "publisher-runtime"),
    XDG_CONFIG_HOME: join(root, "publisher-config"),
  };
  await command(["login", "--api-key-stdin"], remote, announcement.token);
  await command(
    [
      "publish",
      html.artifact.id,
      "--dir",
      directory,
      "--file",
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
        "document.querySelector('[aria-label=\"Published version\"]')?.dataset.versionCount==='2'",
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
  await command(["restart"]);
  assert(
    (await command(["source", "review_imported", "--version", "2", "--file", "index.md"])).includes(
      "Retained legacy content",
    ),
  );
  assert.deepEqual(await readdir(`${environment.R3_DB}.artifacts/backups`), backups);
  if (process.env.R3_TEST_COMPATIBLE === "1")
    console.log(
      "Preview mode: browser compatibility consent; complete network enforcement is not asserted.",
    );
  console.log(
    "Compiled app: artifact upgrade and restart, retained URL and threads, lazy daemon, embedded assets, isolated preview, human utility thread, remote upload, pinned version, offline Markdown and binary reads passed.",
  );
} finally {
  await browser?.close();
  await command(["worker", "stop"]);
  await command(["stop"]);
  await rm(root, { recursive: true, force: true });
}
