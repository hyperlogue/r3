import assert from "node:assert/strict";

// Exercise real IndexedDB transactions in an isolated browser/profile. No user
// database, daemon, credentials, or browser storage belongs to this test.
const playwright = await import(process.env.R3_TEST_PLAYWRIGHT!);
const engine = process.env.R3_TEST_ENGINE ?? "chromium";
const build = await Bun.build({
  entrypoints: ["web/src/markdown-cache.ts"],
  target: "browser",
  minify: true,
});
if (!build.success) throw new Error("Cache acceptance module failed to build");
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/cache.js"
      ? new Response(build.outputs[0], { headers: { "content-type": "text/javascript" } })
      : new Response("<!doctype html><title>Cache acceptance</title>", {
          headers: { "content-type": "text/html" },
        }),
});
const browser = await playwright[engine].launch({
  headless: true,
  executablePath: process.env.R3_TEST_BROWSER,
  ...(engine === "chromium" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
});
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${app.port}`);
  const result = await page.evaluate(async () => {
    const moduleUrl = "/cache.js";
    const { MarkdownCache } = await import(moduleUrl);
    const check = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
    };
    const html = "<!doctype html><main><h1>Cached Markdown</h1></main>";
    const digest = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    const identity = {
      artifactId: "artifact_one",
      versionSeq: 1,
      path: "index.md",
      renderedHash: await digest(html),
      rendererRevision: "fixture-1",
    };
    let now = 1000;
    const options = { now: () => now, budget: html.length * 2, lifetime: 1000 };
    const name = `cache-test-${crypto.randomUUID()}`;
    const cache = new MarkdownCache(name, options);
    let downloads = 0;
    const fetchDocument = async () => {
      downloads++;
      return html;
    };
    await Promise.all([cache.load(identity, fetchDocument), cache.load(identity, fetchDocument)]);
    check(downloads === 1, "concurrent opens share one download");
    const reopened = new MarkdownCache(name, options);
    check(
      (await reopened.load(identity, fetchDocument)) === html && downloads === 1,
      "new instances reuse persistent bytes",
    );
    check(
      (await cache.read({ ...identity, versionSeq: 2 })) === null,
      "version identity is required",
    );
    check(
      (await cache.read({ ...identity, artifactId: "artifact_other" })) === null,
      "another artifact cannot read this entry",
    );
    check(
      (await cache.read({ ...identity, rendererRevision: "fixture-2" })) === null,
      "renderer identity is required",
    );
    now++;
    const second = { ...identity, versionSeq: 2 };
    const third = { ...identity, versionSeq: 3 };
    await cache.load(second, fetchDocument);
    now++;
    await cache.read(identity);
    now++;
    await cache.load(third, fetchDocument);
    check((await cache.read(second)) === null, "least recently opened document is evicted");
    check(
      (await cache.read(identity)) === html && (await cache.read(third)) === html,
      "recent documents fit the byte budget",
    );
    now += 1001;
    check((await cache.read(identity)) === null, "unused documents expire");
    const large = html.repeat(3);
    const largeIdentity = { ...identity, renderedHash: await digest(large) };
    check(
      (await cache.load(largeIdentity, async () => large)) === large,
      "oversized documents still open",
    );
    check((await cache.read(largeIdentity)) === null, "oversized documents are not retained");
    await cache.clear();
    let complete!: (text: string) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const late = cache.load(identity, () => {
      started();
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    });
    await waiting;
    await reopened.clear();
    complete(html);
    await late;
    check(
      (await reopened.read(identity)) === null,
      "another instance's clear prevents late writes",
    );
    await cache.load(identity, fetchDocument);
    let rejected = false;
    try {
      await cache.load({ ...identity, path: "wrong.md" }, async () => "corrupt");
    } catch {
      rejected = true;
    }
    check(rejected, "downloaded bytes must match the authorized hash");
    const open = indexedDB.open(name);
    const database: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const key = JSON.stringify([
      identity.artifactId,
      identity.versionSeq,
      identity.path,
      identity.renderedHash,
      identity.rendererRevision,
    ]);
    const tx = database.transaction("bytes", "readwrite");
    tx.objectStore("bytes").put("corrupted cached bytes", key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    check((await cache.read(identity)) === null, "corrupt cached bytes are never displayed");
    const before = downloads;
    check(
      (await cache.load(identity, fetchDocument)) === html && downloads === before + 1,
      "corruption is repaired by a verified download",
    );
    await cache.reconcile(async () => []);
    check((await cache.read(identity)) === null, "reconnect removes documents deleted while away");
    const unavailable = new MarkdownCache(`unavailable-${crypto.randomUUID()}`, {
      factory: () => {
        throw new Error("Storage disabled");
      },
    });
    check(
      (await unavailable.load(identity, fetchDocument)) === html,
      "storage failures preserve normal reading",
    );
    check((await unavailable.read(identity)) === null, "storage failures behave as cache misses");
    return "persistent reuse, identity, deduplication, LRU, expiry, oversized documents, invalidation races, integrity, reconciliation and storage failure";
  });
  assert.ok(result);
  console.log(`${engine}: ${result}`);
} finally {
  await browser.close();
  app.stop(true);
}
