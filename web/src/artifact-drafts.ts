import { useSyncExternalStore } from "react";
import type { ArtifactMessageContext, ArtifactTarget } from "../../shared/artifacts.ts";

export interface ArtifactDraft {
  body: string;
  target: ArtifactTarget;
  context: ArtifactMessageContext;
  imported?: boolean;
}
interface Drafts {
  note: ArtifactDraft | null;
  replies: Record<string, ArtifactDraft>;
}
const empty = (): Drafts => ({ note: null, replies: {} });
const blank = (): ArtifactDraft => ({
  body: "",
  target: { kind: "artifact" },
  context: { versionSeq: null, representation: null },
});
const prefix = "r3-artifact-draft-";

export class ArtifactDraftStore {
  private readonly cache = new Map<string, Drafts>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private load(id: string): Drafts {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let drafts = empty();
    try {
      const saved = this.storage?.getItem(prefix + id);
      if (saved) {
        const value = JSON.parse(saved) as Drafts;
        const valid = (draft: ArtifactDraft | null) =>
          draft === null ||
          (typeof draft.body === "string" &&
            typeof draft.target?.kind === "string" &&
            draft.context !== undefined);
        if (
          valid(value.note) &&
          value.replies &&
          Object.values(value.replies).every((draft) => draft !== null && valid(draft))
        )
          drafts = value;
      } else {
        const legacy = JSON.parse(this.storage?.getItem(`r3-draft-${id}`) ?? "null");
        if (legacy) {
          // Keep old local drafts readable, with uncertainty visible. Legacy
          // live anchors do not prove a publication or representation.
          const parts = [legacy.general, legacy.text].filter(
            (text) => typeof text === "string" && text.trim(),
          );
          if (parts.length) {
            const evidence = legacy.anchor
              ? `\n\nOriginal draft anchor: ${JSON.stringify(legacy.anchor)}`
              : "";
            drafts.note = { ...blank(), body: parts.join("\n\n") + evidence, imported: true };
          }
          for (const [feedbackId, body] of Object.entries(legacy.replies ?? {}))
            if (typeof body === "string" && body.trim())
              Object.defineProperty(drafts.replies, feedbackId, {
                value: { ...blank(), body, imported: true },
                enumerable: true,
                configurable: true,
              });
        }
      }
    } catch {
      /* Unreadable storage leaves an in-memory composer available. */
    }
    this.cache.set(id, drafts);
    return drafts;
  }

  get(id: string, replyTo?: string): ArtifactDraft | null {
    const drafts = this.load(id);
    return replyTo ? (drafts.replies[replyTo] ?? null) : drafts.note;
  }
  has(id: string): boolean {
    return this.count(id) > 0;
  }
  count(id: string): number {
    const drafts = this.load(id);
    return (
      Number(!!drafts.note?.body.trim()) +
      Object.values(drafts.replies).filter((draft) => !!draft.body.trim()).length
    );
  }
  update(id: string, patch: Partial<ArtifactDraft>, replyTo?: string): void {
    const drafts = this.load(id);
    const next = { ...(this.get(id, replyTo) ?? blank()), ...patch };
    this.commit(
      id,
      replyTo
        ? { ...drafts, replies: { ...drafts.replies, [replyTo]: next } }
        : { ...drafts, note: next },
    );
  }
  anchor(id: string, target: ArtifactTarget): boolean {
    if (this.get(id)?.body.trim()) return false;
    this.update(id, { target, imported: false });
    return true;
  }
  beginReply(id: string, replyTo: string, context: ArtifactMessageContext): void {
    if (this.get(id, replyTo)?.body.trim()) return;
    this.update(id, { context }, replyTo);
  }
  clear(id: string, replyTo?: string): void {
    const drafts = this.load(id);
    if (replyTo) {
      const replies = { ...drafts.replies };
      delete replies[replyTo];
      this.commit(id, { ...drafts, replies });
    } else this.commit(id, { ...drafts, note: null });
  }
  pruneReplies(id: string, feedbackIds: ReadonlySet<string>): void {
    const drafts = this.load(id);
    const entries = Object.entries(drafts.replies);
    const retained = entries.filter(([feedbackId]) => feedbackIds.has(feedbackId));
    if (retained.length !== entries.length)
      this.commit(id, { ...drafts, replies: Object.fromEntries(retained) });
  }
  private commit(id: string, drafts: Drafts): void {
    this.cache.set(id, drafts);
    for (const listener of this.listeners) listener();
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.persist(id);
      }, 400),
    );
  }
  private persist(id: string): void {
    try {
      // Keep an empty record after clearing, so a retained legacy key is not
      // imported again on reload. The original legacy value remains untouched.
      this.storage?.setItem(prefix + id, JSON.stringify(this.load(id)));
    } catch {
      /* Quota/private mode: retain the current in-memory draft. */
    }
  }
  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.persist(id);
    }
    this.timers.clear();
  }
}

const browserStorage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
export const artifactDrafts = new ArtifactDraftStore(browserStorage());
export const useArtifactDraft = (id: string, replyTo?: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.get(id, replyTo));
export const useHasArtifactDraft = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.has(id));
export const useHasArtifactNote = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => !!artifactDrafts.get(id)?.body.trim());
export const useArtifactNoteOpen = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.get(id) !== null);
export const useArtifactDraftCount = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.count(id));
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => artifactDrafts.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) artifactDrafts.flush();
  });
}
