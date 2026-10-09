import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationResponse, loadApplicationAssets } from "../server/application-assets.ts";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";

// Real source rows, selection gestures, composer, and HTTP validation. Neither
// browser credentials nor a running user daemon are used by this fixture.
const { chromium, firefox } = await import(process.env.R3_TEST_PLAYWRIGHT!);
const engine = process.env.R3_TEST_ENGINE === "firefox" ? firefox : chromium;
const assets = await loadApplicationAssets({ index: join(import.meta.dir, "../web/index.html") });
const root = await mkdtemp(join(tmpdir(), "r3-source-discussions-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Source range fixture" });
const lines = [
  "# Changelog",
  "",
  "## Upcoming",
  "",
  "### Changed",
  "",
  "- **HTML previews open with fewer round trips.** Artifact details, publisher names,",
  "  and preview setup arrive with the workspace. Repeat openings preserve valid",
  "  preview URLs so the browser can reuse cached content.",
  "- **Your browser choice is remembered.** After you acknowledge limited preview",
  "  protection, r3 skips capability checks across reloads, tabs, and version changes.",
  "  Previews retain their isolation and limited-protection indicator; **Forget browser",
  "  choice** in **Preview security** restores verification.",
  "",
  "Trailing whitespace  ",
  "",
  "Last line",
  "a".repeat(5000),
  "After the long line",
];
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "fixture",
  content: {
    kind: "files",
    files: [
      {
        path: "CHANGELOG.md",
        mediaType: "text/markdown",
        base64: Buffer.from(`${lines.join("\n")}\n`).toString("base64"),
      },
    ],
  },
});
const diff = storage.artifacts.create({ kind: "diff", actor, title: "Diff range fixture" });
const oldLines = Array.from({ length: 8 }, (_, i) => (i === 7 ? "" : `before ${i + 1}  `));
const newLines = oldLines.map((line) => line.replace("before", "after"));
await storage.artifacts.publish(diff.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "diff",
  content: {
    kind: "diff",
    patch: [
      "diff --git a/code.txt b/code.txt",
      "--- a/code.txt",
      "+++ b/code.txt",
      "@@ -1,8 +1,8 @@",
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
      "",
    ].join("\n"),
  },
});
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 1,
  publicationKey: "second-version",
  content: {
    kind: "files",
    files: [
      {
        path: "CHANGELOG.md",
        mediaType: "text/markdown",
        base64: Buffer.from("Different published version\n").toString("base64"),
      },
    ],
  },
});
const token = randomBytes(32).toString("base64url");
const api = createArtifactApi(storage, {
  token,
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const application = createApplicationResponse(assets, api.bootstrap);
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: (request) =>
    new URL(request.url).pathname.startsWith("/api/")
      ? api.app.fetch(request)
      : application(request),
});
const browser = await engine.launch({
  executablePath: process.env.R3_TEST_BROWSER,
  headless: true,
  ...(engine === chromium ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
});
try {
  const scenarios: {
    kind: "source" | "diff";
    gesture: "gutter" | "text";
    start: number;
    end: number;
    side?: "old" | "new";
    layout?: "split";
    startOffset?: number;
    endOffset?: number;
    backward?: boolean;
    quote?: string;
  }[] = [
    { kind: "source", gesture: "gutter", start: 7, end: 13 },
    { kind: "source", gesture: "gutter", start: 13, end: 7 },
    { kind: "source", gesture: "gutter", start: 7, end: 16 },
    { kind: "source", gesture: "text", start: 7, end: 13 },
    { kind: "source", gesture: "text", start: 7, end: 16 },
    { kind: "diff", gesture: "gutter", start: 1, end: 8, side: "old" },
    { kind: "diff", gesture: "gutter", start: 8, end: 1, side: "new" },
    { kind: "diff", gesture: "text", start: 1, end: 7, side: "old" },
    { kind: "diff", gesture: "text", start: 1, end: 8, side: "new" },
    { kind: "source", gesture: "text", start: 7, end: 13, startOffset: 5, endOffset: 17 },
    { kind: "source", gesture: "text", start: 7, end: 14, endOffset: 0 },
    { kind: "source", gesture: "text", start: 7, end: 13, backward: true },
    { kind: "source", gesture: "gutter", start: 14, end: 17 },
    { kind: "source", gesture: "text", start: 14, end: 17 },
    { kind: "source", gesture: "gutter", start: 18, end: 19, quote: "a".repeat(2048) },
    { kind: "source", gesture: "text", start: 18, end: 19, quote: "a".repeat(2048) },
    { kind: "diff", gesture: "gutter", start: 8, end: 1, side: "old", layout: "split" },
    { kind: "diff", gesture: "text", start: 1, end: 8, side: "old", layout: "split" },
    {
      kind: "diff",
      gesture: "text",
      start: 1,
      end: 7,
      side: "new",
      layout: "split",
      startOffset: 2,
      endOffset: 4,
    },
  ];
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.addInitScript(
      (layout: string) => localStorage.setItem("r3-diff-layout", layout),
      scenario.layout ?? "unified",
    );
    const isDiff = scenario.kind === "diff";
    const id = isDiff ? diff.id : artifact.id;
    const side = scenario.side ?? "new";
    const source = isDiff ? (side === "old" ? oldLines : newLines) : lines;
    await page.goto(
      `http://localhost:${app.port}/${id}?version=1&file=${isDiff ? "code.txt" : "CHANGELOG.md"}&view=${scenario.kind}`,
    );
    const row = (line: number) => `[data-line="${line}"][data-side="${side}"]`;
    await page.locator(row(scenario.end)).waitFor();
    if (scenario.gesture === "gutter") {
      const gutter = (line: number) =>
        page
          .locator(`${row(line)} [data-gutter]`)
          .nth(isDiff && side === "new" && !scenario.layout ? 1 : 0);
      const first = (await gutter(scenario.start).boundingBox())!;
      const last = (await gutter(scenario.end).boundingBox())!;
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 8 });
      await page.mouse.up();
    } else {
      await page.evaluate(
        ({
          first,
          last,
          startOffset,
          endOffset,
          backward,
        }: {
          first: string;
          last: string;
          startOffset?: number;
          endOffset?: number;
          backward?: boolean;
        }) => {
          const start = document.querySelector(`${first} code`)!;
          const end = document.querySelector(`${last} code`)!;
          const range = document.createRange();
          range.setStart(start, 0);
          range.setEnd(end, end.childNodes.length);
          const point = (row: string, offset: number): [Node, number] => {
            const code = document.querySelector(`${row} [data-source-text]`)!;
            const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const length = node.textContent!.length;
              if (offset <= length) return [node, offset];
              offset -= length;
            }
            throw new Error("Selection offset outside source text");
          };
          if (startOffset !== undefined) range.setStart(...point(first, startOffset));
          if (endOffset !== undefined) range.setEnd(...point(last, endOffset));
          const selection = getSelection()!;
          selection.removeAllRanges();
          if (backward)
            selection.setBaseAndExtent(
              range.endContainer,
              range.endOffset,
              range.startContainer,
              range.startOffset,
            );
          else selection.addRange(range);
          end.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
        },
        {
          first: row(scenario.start),
          last: row(scenario.end),
          startOffset: scenario.startOffset,
          endOffset: scenario.endOffset,
          backward: scenario.backward,
        },
      );
    }
    const composer = page.locator("[data-artifact-composer]:not([data-comment-to]):visible");
    await composer.locator("textarea").fill("Please consolidate this range.");
    const posted = page.waitForResponse(
      (response: any) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/discussions"),
    );
    await composer.getByRole("button", { name: "Add discussions", exact: true }).click();
    const response = await posted;
    assert.equal(response.status(), 201, await response.text());
    const note = await response.json();
    const start = Math.min(scenario.start, scenario.end);
    const end = Math.max(scenario.start, scenario.end) - (scenario.endOffset === 0 ? 1 : 0);
    const selected = source.slice(start - 1, end);
    if (scenario.endOffset)
      selected[selected.length - 1] = selected.at(-1)!.slice(0, scenario.endOffset);
    if (scenario.startOffset) selected[0] = selected[0].slice(scenario.startOffset);
    assert.equal(note.target.kind, scenario.kind);
    assert.equal(note.target.versionSeq, 1);
    assert.deepEqual(
      storage.conversations.list(id).find((saved) => saved.id === note.id)?.target,
      note.target,
    );
    assert.deepEqual(note.target.locator, {
      ...(isDiff ? { side } : {}),
      start,
      end,
      quote: scenario.quote ?? selected.slice(0, 4).join("\n").trim(),
    });
    const read = await fetch(`http://localhost:${app.port}/api/discussions/${note.id}/source`, {
      headers: { "x-r3-token": token },
    });
    assert.equal(read.status, 200);
    const fullRange = await read.json();
    assert.equal(fullRange.text, source.slice(start - 1, end).join("\n"));
    assert.equal(storage.conversations.get(note.id).comments[0]!.sentAt, null);
    await page.close();
  }
  console.log(
    "Source/diff discussions: compact excerpts retain full ranges, retrievable without acknowledgment.",
  );
} finally {
  await browser.close();
  app.stop(true);
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
