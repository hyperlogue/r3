import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationResponse, loadApplicationAssets } from "../server/application-assets.ts";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { fileViewedKey } from "../web/src/viewed.ts";
import { eventually, openTestBrowser } from "./browser.ts";

// Exercise the real workspace, authenticated resource reads, OS clipboard, and
// browser downloads. All storage, downloaded bytes, and browser state are disposable.
const assets = await loadApplicationAssets({ index: join(import.meta.dir, "../web/index.html") });
const root = await mkdtemp(join(tmpdir(), "r3-file-actions-"));
const downloads = join(root, "downloads");
await mkdir(downloads);
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human", sessionId: null } as const;
const files = storage.artifacts.create({ kind: "files", actor, title: "File actions" });
const samples = [
  {
    path: "a/components/Player.tsx",
    mediaType: "text/plain",
    bytes: Buffer.from("export const ready = true;\n"),
  },
  { path: "docs/guide.md", mediaType: "text/markdown", bytes: Buffer.from("# Published guide\n") },
  {
    path: "docs/page.html",
    mediaType: "text/html",
    bytes: Buffer.from("<!doctype html><title>Published page</title><h1>Original bytes</h1>"),
  },
  {
    path: "media/landscape.svg",
    mediaType: "image/svg+xml",
    bytes: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="green"/></svg>',
    ),
  },
  {
    path: "media/tone.wav",
    mediaType: "audio/wav",
    bytes: Buffer.from(
      "RIFF\u0024\0\0\0WAVEfmt \u0010\0\0\0\u0001\0\u0001\0\u0044\u0056\0\0\u0088\u00ac\0\0\u0002\0\u0010\0data\0\0\0\0",
      "latin1",
    ),
  },
  {
    path: "media/clip.mp4",
    mediaType: "video/mp4",
    bytes: Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypmp42"), 0, 0, 0, 0]),
  },
  {
    path: "z/data.bin",
    mediaType: "application/octet-stream",
    bytes: Buffer.from([0, 128, 255, 10]),
  },
];
for (const seq of [1, 2]) {
  await storage.artifacts.publish(files.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `version-${seq}`,
    content: {
      kind: "files",
      files: samples.map((sample) => ({
        path: sample.path,
        mediaType: sample.mediaType,
        base64: (seq === 1
          ? sample.bytes
          : Buffer.concat([sample.bytes, Buffer.from("newer version")])
        ).toString("base64"),
      })),
    },
  });
  for (const file of storage.artifacts.files(files.id, seq))
    storage.artifacts.setViewed(files.id, {
      key: fileViewedKey(file.path, file.hash),
      viewed: true,
    });
}
const diff = storage.artifacts.create({ kind: "diff", actor, title: "Diff file actions" });
await storage.artifacts.publish(diff.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "diff",
  content: {
    kind: "diff",
    patch:
      "diff --git a/nested/code.ts b/nested/code.ts\n--- a/nested/code.ts\n+++ b/nested/code.ts\n@@ -1 +1 @@\n-before\n+after\n",
  },
});
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "file-actions-acceptance",
  allowedHost: (host) => host === "localhost",
});
const application = createApplicationResponse(assets, api.bootstrap);
const resourceReads: string[] = [];
let failNextDownload = false;
let holdNextDownload: Promise<void> | null = null;
let releaseDownload: (() => void) | undefined;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return application(request);
    const response = await api.app.fetch(request);
    if (url.pathname.endsWith("/resource") && response.ok) {
      resourceReads.push(`${url.pathname}?${url.searchParams}`);
      if (holdNextDownload) {
        const wait = holdNextDownload;
        holdNextDownload = null;
        await wait;
      }
      if (failNextDownload) {
        failNextDownload = false;
        return Response.json({ error: "Download temporarily unavailable" }, { status: 503 });
      }
    }
    return response;
  },
});
const origin = `http://localhost:${app.port}`;
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser([
    "--blink-settings=availablePointerTypes=4,primaryPointerType=4,availableHoverTypes=2,primaryHoverType=2",
  ]);
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await browser.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  const started: { guid: string; suggestedFilename: string }[] = [];
  const completed = new Set<string>();
  const errors: unknown[] = [];
  browser.listen((event) => {
    if (event.method === "Browser.downloadWillBegin") started.push(event.params);
    if (event.method === "Browser.downloadProgress" && event.params.state === "completed")
      completed.add(event.params.guid);
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
  });
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await page.command("Page.navigate", { url: `${origin}/${files.id}?version=1` });
  const header = (path: string) => `[data-file=${JSON.stringify(path)}] [data-file-header]`;
  const control = (path: string, label: string) =>
    `${header(path)} [aria-label=${JSON.stringify(label)}]`;
  const copy = (path: string, suffix: string) => control(path, `Copy ${suffix}`);
  const download = (path: string) => control(path, `Download ${path.split("/").at(-1)}`);
  const exists = (selector: string) =>
    page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
  const hover = async (selector: string) => {
    const point = await page.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:"nearest"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    return point;
  };
  const click = async (selector: string) => {
    await eventually(
      () => page.evaluate(`!document.querySelector(${JSON.stringify(selector)})?.disabled`),
      "control ready for next click",
    );
    const point = await hover(selector);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.command("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  };
  const saved = async (index: number, sample: (typeof samples)[number]) => {
    const item = await eventually(async () => started[index], "browser download starts");
    await eventually(async () => completed.has(item.guid), "browser saves original bytes");
    assert.equal(item.suggestedFilename, sample.path.split("/").at(-1));
    assert.deepEqual(await readFile(join(downloads, item.guid)), sample.bytes);
  };
  await eventually(
    () =>
      page.evaluate(`document.querySelectorAll('[data-file-header]').length === ${samples.length}`),
    "all file headers",
  );
  const source = samples[0].path;
  const sourceHeader = header(source);
  const success = `${sourceHeader} [data-path-copy=success]`;
  const viewedBefore = storage.artifacts.viewed(files.id);
  assert(
    await page.evaluate(
      "Array.from(document.querySelectorAll('[data-file-header] [aria-label^=Download]')).every(e=>getComputedStyle(e).opacity==='0')",
    ),
    "Downloads hide outside the path area",
  );
  await hover(copy(source, "components/Player.tsx"));
  assert(
    await page.evaluate(`(() => {
    const h=document.querySelector(${JSON.stringify(sourceHeader)});
    const d=h.querySelector('[aria-label^=Download]').getBoundingClientRect();
    return [h.querySelector('[aria-pressed]'),h.querySelector('button[title="Leave feedback on this file"]')].every(e=>{const r=e.getBoundingClientRect();return Math.abs(r.top-d.top)<.1&&Math.abs(r.height-d.height)<.1;});
  })()`),
    "Download hover background aligns with Viewed and feedback controls",
  );
  assert(
    await page.evaluate(
      `getComputedStyle(document.querySelector(${JSON.stringify(download(source))})).opacity === "1"`,
    ),
    "Hovering the path reveals download",
  );
  assert.equal(
    await page.evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(`${sourceHeader} button[aria-label^=Copy]`)})).filter(e=>getComputedStyle(e).textDecorationLine.includes("underline")).map(e=>e.textContent).join("")`,
    ),
    "components/Player.tsx",
  );
  for (const suffix of ["Player.tsx", "components/Player.tsx", source]) {
    await click(copy(source, suffix));
    await eventually(
      () =>
        page.evaluate(
          `navigator.clipboard.readText().then(text=>text===${JSON.stringify(suffix)})`,
        ),
      "exact copied suffix",
    );
    assert(await exists(success), "Successful copies show a confirmation");
  }
  await Bun.sleep(600);
  await click(copy(source, source));
  await Bun.sleep(600);
  assert(await exists(success), "Repeated copies restart the one-second confirmation");
  await Bun.sleep(500);
  assert(!(await exists(success)), "Copy confirmation expires");

  await page.evaluate(
    `window.originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard); window.originalExec = document.execCommand.bind(document); navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); }; document.execCommand = () => false;`,
  );
  await click(copy(source, source));
  await eventually(
    () => exists(`${sourceHeader} [data-path-copy=error]`),
    "clipboard failure feedback",
  );
  assert(!(await exists(success)), "A failed copy cannot show success");
  await page.evaluate(
    "window.copyResolutions = []; navigator.clipboard.writeText = () => new Promise(resolve => window.copyResolutions.push(resolve));",
  );
  await click(copy(source, source));
  await click(copy(source, "Player.tsx"));
  await page.evaluate("window.copyResolutions[1]()");
  await eventually(() => exists(success), "newer clipboard completion");
  await page.evaluate("window.copyResolutions[0]()");
  assert.equal(
    await page.evaluate(
      `document.querySelector(${JSON.stringify(`${sourceHeader} [role=status]`)}).textContent`,
    ),
    "Copied: Player.tsx",
    "A late older copy cannot replace the current confirmation",
  );
  await page.evaluate(
    "navigator.clipboard.writeText = window.originalWrite; document.execCommand = window.originalExec;",
  );

  holdNextDownload = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  await click(download(source));
  await eventually(
    () => page.evaluate(`document.querySelector(${JSON.stringify(download(source))}).disabled`),
    "download pending state",
  );
  await page.evaluate(`document.querySelector(${JSON.stringify(download(source))}).click()`);
  await eventually(async () => resourceReads.length === 1, "one download request while pending");
  releaseDownload!();
  await saved(0, samples[0]);
  for (const sample of samples.slice(1)) {
    const index = started.length;
    await click(download(sample.path));
    await saved(index, sample);
  }
  assert(
    resourceReads.every((url) => url.includes("/versions/1/resource")),
    "Downloads retain the selected version even when a newer one exists",
  );
  assert.deepEqual(
    storage.artifacts.viewed(files.id),
    viewedBefore,
    "Copying and downloading preserve Viewed marks",
  );

  const binary = samples.at(-1)!;
  // The successful immutable resource is cached; force this attempt to reach
  // the fixture's failing endpoint rather than reusing its previous bytes.
  await page.command("Network.clearBrowserCache");
  failNextDownload = true;
  await click(download(binary.path));
  const failure = '.r3-notification[data-notification-tone="error"]';
  await eventually(() => exists(failure), "download failure visible outside a folded body");
  assert(
    await page.evaluate(
      `document.querySelector(${JSON.stringify(failure)}).getBoundingClientRect().height > 0`,
    ),
  );
  assert(await exists(`${header(binary.path)} [title=Expand]`), "Failure does not unfold the file");
  const retry = started.length;
  await click(download(binary.path));
  await saved(retry, binary);
  await eventually(async () => !(await exists(failure)), "retry clears download error");

  await page.evaluate(
    `document.querySelector(${JSON.stringify(copy(source, "Player.tsx"))}).focus()`,
  );
  for (const type of ["keyDown", "keyUp"])
    await page.command("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
  await eventually(
    () => page.evaluate('navigator.clipboard.readText().then(text=>text==="Player.tsx")'),
    "keyboard path copying",
  );
  await page.evaluate(
    `document.activeElement.blur(); document.querySelector(${JSON.stringify(download(source))}).focus()`,
  );
  assert(
    await page.evaluate(
      `getComputedStyle(document.querySelector(${JSON.stringify(download(source))})).opacity === "1"`,
    ),
    "Keyboard focus reveals download",
  );

  for (const width of [1280, 390, 320]) {
    await page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await page.command("Emulation.setTouchEmulationEnabled", { enabled: width < 768 });
    if (width < 768)
      assert(
        await page.evaluate(
          "Array.from(document.querySelectorAll('[data-file-header] [aria-label^=Download]')).every(e=>getComputedStyle(e).opacity==='1')",
        ),
        "Touch download controls remain visible",
      );
    await click(copy(source, "Player.tsx"));
    await eventually(() => exists(success), "responsive copy confirmation");
    assert(
      await page.evaluate(
        `(() => {const h=document.querySelector(${JSON.stringify(sourceHeader)});const a=h.querySelector('[data-path-copy]').getBoundingClientRect();const v=h.querySelector('[aria-pressed]').getBoundingClientRect();return a.right<=v.left&&h.getBoundingClientRect().right<=innerWidth;})()`,
      ),
      "Path confirmation and file controls fit without overlapping",
    );
    if (process.env.R3_TEST_SCREENSHOTS) {
      await mkdir(process.env.R3_TEST_SCREENSHOTS, { recursive: true });
      for (const dark of [false, true]) {
        await page.evaluate(`document.documentElement.classList.toggle("dark", ${dark})`);
        const screenshot = await page.command("Page.captureScreenshot", { format: "png" });
        await Bun.write(
          join(
            process.env.R3_TEST_SCREENSHOTS,
            `file-actions-${width}-${dark ? "dark" : "light"}.png`,
          ),
          Buffer.from(screenshot.data, "base64"),
        );
      }
    }
  }
  await page.command("Page.navigate", { url: `${origin}/${diff.id}` });
  await eventually(
    () => exists(copy("nested/code.ts", "code.ts")),
    "diff headers reuse path copying",
  );
  assert(
    !(await exists('[data-file-header] [aria-label^="Download"]')),
    "Sparse diffs do not offer complete-file downloads",
  );
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log(
    "File header acceptance passed: original versioned bytes and filenames for every file type, pending/retry behavior, suffix copying, confirmation timing/races, and keyboard/touch layouts.",
  );
} finally {
  releaseDownload?.();
  await browser?.close();
  app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
