import { ArtifactApiError } from "../../shared/artifact-client.ts";
import type { ArtifactPreviewContext, ArtifactPreviewNetwork } from "../../shared/artifacts.ts";
import { artifactApi } from "./artifact-api.ts";

type PreviewApi = Pick<typeof artifactApi, "createPreview" | "renewPreview" | "revokePreview">;
type Saved = {
  artifactId: string;
  seq: number;
  path: string;
  network: "blocked" | "compatible";
  id: string;
};
const STORAGE_KEY = "r3-preview-sessions-1";
const LIMIT = 16;
const keyOf = (id: string, seq: number, path: string, network: string) =>
  JSON.stringify([id, seq, path, network]);

// Retain only protected context identities, not documents or permission grants.
// Authenticated renewal and the iframe gate still run on every visit. Stable
// URLs let the browser's HTTP cache reuse bytes across visits and page refreshes.
export class PreviewSessions {
  private readonly saved = new Map<string, Saved>();
  private readonly live = new Map<string, number>();
  private readonly pending = new Map<string, Promise<ArtifactPreviewContext>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly api: PreviewApi,
    private readonly storage: () => Pick<Storage, "getItem" | "setItem"> | null,
  ) {
    try {
      const entries: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(entries))
        for (const entry of entries.slice(-LIMIT)) {
          if (
            entry &&
            typeof entry.artifactId === "string" &&
            Number.isSafeInteger(entry.seq) &&
            entry.seq > 0 &&
            typeof entry.path === "string" &&
            (entry.network === "blocked" || entry.network === "compatible") &&
            typeof entry.id === "string" &&
            /^p[0-9a-f]{48}$/.test(entry.id)
          )
            this.saved.set(keyOf(entry.artifactId, entry.seq, entry.path, entry.network), entry);
        }
    } catch {
      /* Storage can be unavailable; in-tab reuse still works. */
    }
  }

  private persist() {
    try {
      this.storage()?.setItem(STORAGE_KEY, JSON.stringify([...this.saved.values()].slice(-LIMIT)));
    } catch {
      /* Browser storage is optional. */
    }
  }

  private revoke(id: string) {
    void this.api.revokePreview(id).catch(() => {});
  }

  private trim() {
    for (const [key, entry] of this.saved) {
      if (this.saved.size <= LIMIT) break;
      if (this.live.has(entry.id) || this.pending.has(key)) continue;
      this.saved.delete(key);
      this.revoke(entry.id);
    }
  }

  async acquire(
    artifactId: string,
    seq: number,
    path: string,
    network: ArtifactPreviewNetwork,
  ): Promise<ArtifactPreviewContext> {
    if (network === "external") return this.api.createPreview(artifactId, seq, path, network);
    const key = keyOf(artifactId, seq, path, network);
    let pending = this.pending.get(key);
    if (!pending) {
      const generation = this.generations.get(artifactId);
      pending = (async () => {
        let context: ArtifactPreviewContext | undefined;
        const saved = this.saved.get(key);
        if (saved) {
          try {
            const renewed = await this.api.renewPreview(saved.id);
            if (
              renewed.artifactId === artifactId &&
              renewed.versionSeq === seq &&
              renewed.network === network &&
              renewed.presentation === "document" &&
              renewed.documentUrl ===
                renewed.resourceRoot + path.split("/").map(encodeURIComponent).join("/")
            )
              context = renewed;
          } catch (error) {
            if (!(error instanceof ArtifactApiError && error.status === 404)) throw error;
          }
          this.saved.delete(key);
        }
        context ??= await this.api.createPreview(artifactId, seq, path, network);
        if (this.generations.get(artifactId) !== generation) {
          this.revoke(context.id);
          throw new Error("Artifact preview is no longer available");
        }
        if (context.presentation === "document") {
          this.saved.set(key, { artifactId, seq, path, network, id: context.id });
          this.trim();
          this.persist();
        }
        return context;
      })();
      this.pending.set(key, pending);
      const clean = () => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      };
      void pending.then(clean, clean);
    }
    const context = await pending;
    this.live.set(context.id, (this.live.get(context.id) ?? 0) + 1);
    return context;
  }

  release(context: ArtifactPreviewContext, retain = true) {
    if (!retain)
      for (const [key, entry] of this.saved) if (entry.id === context.id) this.saved.delete(key);
    const count = (this.live.get(context.id) ?? 1) - 1;
    if (count > 0) {
      this.live.set(context.id, count);
      return;
    }
    this.live.delete(context.id);
    if (![...this.saved.values()].some((entry) => entry.id === context.id)) this.revoke(context.id);
    this.trim();
    this.persist();
  }

  forget(artifactId: string) {
    this.generations.set(artifactId, (this.generations.get(artifactId) ?? 0) + 1);
    for (const key of this.pending.keys())
      if (key.startsWith(`[${JSON.stringify(artifactId)},`)) this.pending.delete(key);
    for (const [key, entry] of this.saved)
      if (entry.artifactId === artifactId) {
        this.saved.delete(key);
        this.revoke(entry.id);
      }
    this.persist();
  }
}

export const previewSessions = new PreviewSessions(artifactApi, () => sessionStorage);
