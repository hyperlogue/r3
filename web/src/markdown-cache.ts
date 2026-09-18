import { hrefFor } from "./router.ts";

export interface MarkdownIdentity {
  artifactId: string;
  versionSeq: number;
  path: string;
  renderedHash: string;
  rendererRevision: string;
}

interface Entry {
  key: string;
  artifactId: string;
  usedAt: number;
  bytes: number;
}

const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });

export async function markdownMatches(html: string, hash: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  return (
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") ===
    hash
  );
}

// Only the trusted workspace owns this cache. Its keys confer no server access,
// and neither preview capabilities nor injected runtime/permissions are stored.
export class MarkdownCache {
  private database: Promise<IDBDatabase> | undefined;
  private pending = new Map<string, Promise<string>>();
  private listeners = new Set<(artifactId: string | null) => void>();
  private channel: BroadcastChannel | undefined;
  private generation = 0;

  constructor(
    private readonly name: string,
    private readonly options: {
      factory?: () => IDBFactory;
      now?: () => number;
      budget?: number;
      lifetime?: number;
    } = {},
  ) {}

  private get now() {
    return (this.options.now ?? Date.now)();
  }
  private get budget() {
    return this.options.budget ?? 64 * 1024 * 1024;
  }
  private get lifetime() {
    return this.options.lifetime ?? 30 * 24 * 3600_000;
  }
  private key(value: MarkdownIdentity) {
    return JSON.stringify([
      value.artifactId,
      value.versionSeq,
      value.path,
      value.renderedHash,
      value.rendererRevision,
    ]);
  }

  private connect() {
    if (!this.channel && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(this.name);
      this.channel.onmessage = (event) => {
        if (event.data === null || typeof event.data === "string") this.notify(event.data);
      };
    }
  }

  private notify(artifactId: string | null) {
    this.generation++;
    this.pending.clear();
    for (const listener of this.listeners) listener(artifactId);
  }

  subscribe(listener: (artifactId: string | null) => void) {
    this.connect();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private open() {
    this.connect();
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = (this.options.factory?.() ?? indexedDB).open(this.name, 1);
      let blocked = false;
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("entries", { keyPath: "key" });
        opening.result.createObjectStore("bytes");
        opening.result.createObjectStore("state");
      };
      opening.onblocked = () => {
        blocked = true;
        reject(new Error("Document cache is busy"));
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          this.database = undefined;
        };
        resolve(database);
      };
    });
    return this.database;
  }

  private async transaction<T>(run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const database = await this.open();
    const tx = database.transaction(["entries", "bytes", "state"], "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Document cache unavailable"));
    });
    // Attach both continuations immediately, including when the operation fails.
    const [result] = await Promise.all([run(tx), done]);
    return result;
  }

  private async lookup(value: MarkdownIdentity) {
    const key = this.key(value);
    try {
      return await this.transaction(async (tx) => {
        const epoch = (await request(tx.objectStore("state").get("epoch"))) ?? 0;
        const entries = tx.objectStore("entries");
        const entry: Entry | undefined = await request(entries.get(key));
        if (!entry) return { epoch, html: null };
        if (this.now - entry.usedAt >= this.lifetime) {
          entries.delete(key);
          tx.objectStore("bytes").delete(key);
          return { epoch, html: null };
        }
        entries.put({ ...entry, usedAt: this.now });
        const html: unknown = await request(tx.objectStore("bytes").get(key));
        return { epoch, html: typeof html === "string" ? html : null };
      });
    } catch {
      return { epoch: null, html: null };
    }
  }

  async read(value: MarkdownIdentity): Promise<string | null> {
    const generation = this.generation;
    const { html } = await this.lookup(value);
    if (html === null) return null;
    try {
      return (await markdownMatches(html, value.renderedHash)) && generation === this.generation
        ? html
        : null;
    } catch {
      return null;
    }
  }

  load(value: MarkdownIdentity, fetchDocument: () => Promise<string>): Promise<string> {
    const key = this.key(value);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.loadDocument(value, fetchDocument);
      this.pending.set(key, pending);
      const clean = () => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      };
      void pending.then(clean, clean);
    }
    return pending;
  }

  private async loadDocument(value: MarkdownIdentity, fetchDocument: () => Promise<string>) {
    const { epoch, html } = await this.lookup(value);
    if (html !== null && (await markdownMatches(html, value.renderedHash))) return html;
    const fresh = await fetchDocument();
    if (!(await markdownMatches(fresh, value.renderedHash)))
      throw new Error("Rendered document integrity check failed");
    const bytes = new TextEncoder().encode(fresh).byteLength;
    if (epoch !== null && bytes <= this.budget) {
      try {
        await this.transaction(async (tx) => {
          // This transaction also protects against another tab's logout/deletion
          // while a download was pending. A late response cannot repopulate it.
          if (((await request(tx.objectStore("state").get("epoch"))) ?? 0) !== epoch) return;
          const entries = tx.objectStore("entries");
          const key = this.key(value);
          const retained: Entry[] = await request(entries.getAll());
          let total =
            bytes +
            retained
              .filter((entry) => entry.key !== key)
              .reduce((sum, entry) => sum + entry.bytes, 0);
          const candidates = retained
            .filter((entry) => entry.key !== key)
            .sort((a, b) => a.usedAt - b.usedAt);
          for (const entry of candidates) {
            if (this.now - entry.usedAt >= this.lifetime || total > this.budget) {
              entries.delete(entry.key);
              tx.objectStore("bytes").delete(entry.key);
              total -= entry.bytes;
            }
          }
          entries.put({
            key,
            artifactId: value.artifactId,
            usedAt: this.now,
            bytes,
          } satisfies Entry);
          tx.objectStore("bytes").put(fresh, key);
        });
      } catch {
        /* Quota/private-mode failures never prevent reading. */
      }
    }
    return fresh;
  }

  private async purge(remove: (entry: Entry) => boolean, artifactId: string | null) {
    this.notify(artifactId);
    this.connect();
    this.channel?.postMessage(artifactId);
    try {
      await this.transaction(async (tx) => {
        const state = tx.objectStore("state");
        state.put(((await request(state.get("epoch"))) ?? 0) + 1, "epoch");
        const entries = tx.objectStore("entries");
        for (const entry of await request<Entry[]>(entries.getAll())) {
          if (!remove(entry)) continue;
          entries.delete(entry.key);
          tx.objectStore("bytes").delete(entry.key);
        }
      });
    } catch {
      /* Storage may be unavailable or already evicted. */
    }
  }

  forget(artifactId: string) {
    return this.purge((entry) => entry.artifactId === artifactId, artifactId);
  }
  clear() {
    return this.purge(() => true, null);
  }
  async reconcile(listArtifacts: () => Promise<string[]>) {
    try {
      const entries = await this.transaction((tx) =>
        request<Entry[]>(tx.objectStore("entries").getAll()),
      );
      if (!entries.length) return;
      const retained = new Set(await listArtifacts());
      const missing = new Set(
        entries.filter((entry) => !retained.has(entry.artifactId)).map((entry) => entry.artifactId),
      );
      for (const id of missing) await this.forget(id);
    } catch {
      /* A transient failure cannot establish deletion. */
    }
  }
}

export const markdownCache = new MarkdownCache(`r3-markdown-cache-1:${hrefFor("/")}`);
