import { TOKEN } from "../api.ts";
import { markdownCache } from "../markdown-cache.ts";
import { hrefFor } from "../router.ts";

export interface PublishedFile {
  hash: string;
  byteLength: number;
  mediaType: string;
}

interface Entry {
  bytes: number;
  usedAt: number;
  artifacts: string[];
}
type Index = Record<string, Entry>;

const BUDGET = 1024 * 1024 * 1024;
const LIFETIME = 30 * 24 * 3600_000;
const TOUCH = 3600_000;

async function digest(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Published bytes keyed by SHA-256, so one download serves every version, path,
// and artifact that publishes them. Only the trusted workspace owns this cache.
// The HTTP cache cannot take its place: Chromium rejects large entries, and
// logout and artifact deletion must be able to remove retained bytes.
export class PublishedBytes {
  private generation = 0;
  private readonly downloads = new Map<string, Promise<Blob>>();
  private retaining: Promise<boolean> | undefined;

  constructor(
    private readonly name: string,
    private readonly permitted: () => Promise<boolean>,
  ) {}

  private url(hash: string) {
    return hrefFor(`/api/blobs/${hash}`);
  }

  // One lock orders the index and its bytes across tabs. Private modes and quota
  // failures return null, which leaves every read on the network path.
  private async update<T>(run: (cache: Cache, index: Index) => Promise<T>): Promise<T | null> {
    if (typeof caches === "undefined" || typeof navigator.locks === "undefined") return null;
    try {
      return await navigator.locks.request(this.name, async () => {
        const cache = await caches.open(this.name);
        const key = this.url("index");
        let index: Index = {};
        try {
          index = (await (await cache.match(key))?.json()) ?? {};
        } catch {
          /* An unreadable index only forgets what was retained. */
        }
        const before = JSON.stringify(index);
        const result = await run(cache, index);
        const after = JSON.stringify(index);
        if (after !== before) await cache.put(key, new Response(after));
        return result;
      });
    } catch {
      return null;
    }
  }

  async cached(artifactId: string, file: PublishedFile): Promise<Blob | null> {
    const now = Date.now();
    const response = await this.update(async (cache, index) => {
      const entry = index[file.hash];
      if (!entry) return null;
      const url = this.url(file.hash);
      const stored = now - entry.usedAt < LIFETIME ? await cache.match(url) : undefined;
      if (!stored) {
        delete index[file.hash];
        await cache.delete(url);
        return null;
      }
      if (now - entry.usedAt > TOUCH) entry.usedAt = now;
      if (!entry.artifacts.includes(artifactId)) entry.artifacts.push(artifactId);
      return stored;
    });
    const blob = await response?.blob().catch(() => null);
    return blob?.size === file.byteLength ? blob.slice(0, blob.size, file.mediaType) : null;
  }

  // Concurrent readers share one download. A reader's abort releases only that
  // reader; the download still completes and is retained for the next visit.
  async load(artifactId: string, file: PublishedFile, signal?: AbortSignal): Promise<Blob> {
    const cached = await abortable(this.cached(artifactId, file), signal);
    if (cached) return cached;
    let download = this.downloads.get(file.hash);
    if (!download) {
      download = this.download(artifactId, file);
      this.downloads.set(file.hash, download);
      const settled = () => {
        if (this.downloads.get(file.hash) === download) this.downloads.delete(file.hash);
      };
      download.then(settled, settled);
    }
    const blob = await abortable(download, signal);
    return blob.slice(0, blob.size, file.mediaType);
  }

  private async download(artifactId: string, file: PublishedFile): Promise<Blob> {
    const generation = this.generation;
    this.retaining ??= this.update(async () => true).then(Boolean);
    const retaining = await this.retaining;
    const response = await fetch(this.url(file.hash), {
      headers: TOKEN ? { "x-r3-token": TOKEN } : undefined,
      credentials: "same-origin",
      redirect: "error",
      // Retained bytes need no second copy in the HTTP cache.
      cache: retaining ? "no-store" : "default",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Published file is unavailable (${response.status})`);
    const blob = await response.blob();
    if (
      blob.size !== file.byteLength ||
      (typeof crypto.subtle !== "undefined" && (await digest(blob)) !== file.hash)
    )
      throw new Error("Published file failed its integrity check");
    if (retaining && file.byteLength <= BUDGET && (await this.permitted()))
      await this.update(async (cache, index) => {
        // A logout or deletion during the download must not repopulate the cache.
        if (generation !== this.generation) return;
        const now = Date.now();
        const others = Object.entries(index)
          .filter(([hash]) => hash !== file.hash)
          .sort((a, b) => a[1].usedAt - b[1].usedAt);
        let total = others.reduce((sum, [, entry]) => sum + entry.bytes, file.byteLength);
        for (const [hash, entry] of others) {
          if (now - entry.usedAt < LIFETIME && total <= BUDGET) continue;
          delete index[hash];
          await cache.delete(this.url(hash));
          total -= entry.bytes;
        }
        await cache.put(this.url(file.hash), new Response(blob));
        index[file.hash] = { bytes: file.byteLength, usedAt: now, artifacts: [artifactId] };
      });
    return blob;
  }

  forget(artifactId: string) {
    this.generation++;
    return this.update(async (cache, index) => {
      for (const [hash, entry] of Object.entries(index)) {
        entry.artifacts = entry.artifacts.filter((id) => id !== artifactId);
        if (entry.artifacts.length) continue;
        delete index[hash];
        await cache.delete(this.url(hash));
      }
    });
  }

  clear() {
    this.generation++;
    return this.update(async (cache, index) => {
      for (const hash of Object.keys(index)) delete index[hash];
      for (const request of await cache.keys()) await cache.delete(request);
    });
  }

  async reconcile(listArtifacts: () => Promise<string[]>) {
    const referenced = await this.update(
      async (_cache, index) => new Set(Object.values(index).flatMap((entry) => entry.artifacts)),
    );
    if (!referenced?.size) return;
    let retained: Set<string>;
    try {
      retained = new Set(await listArtifacts());
    } catch {
      // A transient failure cannot establish deletion.
      return;
    }
    for (const id of referenced) if (!retained.has(id)) await this.forget(id);
  }
}

export const publishedBytes = new PublishedBytes(
  `r3-published-bytes-1:${hrefFor("/")}`,
  async () => !(await markdownCache.authenticationSuspended()),
);
// The Markdown cache already announces every logout and artifact deletion, in
// this tab and from other tabs. Following it keeps one retention policy, and it
// must start with the application so earlier visits' bytes are purged too.
markdownCache.subscribe((artifactId) => {
  void (artifactId === null ? publishedBytes.clear() : publishedBytes.forget(artifactId));
});
