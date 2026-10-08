import { useSyncExternalStore } from "react";
import type { ArtifactMessageContext, ArtifactTarget } from "../../shared/artifacts.ts";
import { hasMessageContent } from "../../shared/attachments.ts";
import { type DraftAttachment, draftImages } from "./attachment-drafts.ts";

export interface ArtifactDraft {
  mediaSnapshot?: DraftAttachment;
  attachments?: DraftAttachment[];
  operationKey?: string;
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
const slotPrefix = "r3-artifact-draft-slot-";
type Slot = string | null;
const slotKey = (id: string, replyTo: Slot) => slotPrefix + JSON.stringify([id, replyTo]);
const valid = (draft: ArtifactDraft | null) =>
  draft === null ||
  (typeof draft?.body === "string" &&
    typeof draft.target?.kind === "string" &&
    draft.context !== undefined &&
    (draft.attachments === undefined ||
      (Array.isArray(draft.attachments) &&
        draft.attachments.length <= 4 &&
        draft.attachments.every(
          (image) =>
            image &&
            typeof image.id === "string" &&
            ["image/png", "image/jpeg"].includes(image.mediaType) &&
            [image.width, image.height, image.byteLength].every(
              (value) => Number.isFinite(value) && value >= 0,
            ),
        ))));
function recover(draft: ArtifactDraft | null): ArtifactDraft | null {
  if (!draft?.attachments?.some((image) => image.pending)) return draft;
  return {
    ...draft,
    attachments: draft.attachments.map((image) =>
      image.pending
        ? {
            ...image,
            pending: false,
            error: "Image preparation was interrupted. Remove it and attach it again.",
          }
        : image,
    ),
  };
}
function parseSlotKey(key: string): [string, Slot] | null {
  if (!key.startsWith(slotPrefix)) return null;
  try {
    const value = JSON.parse(key.slice(slotPrefix.length));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      (value[1] === null || typeof value[1] === "string")
    )
      return value as [string, Slot];
  } catch {
    /* Ignore unrelated or unreadable keys. */
  }
  return null;
}
function withDraft(drafts: Drafts, replyTo: Slot, draft: ArtifactDraft | null): Drafts {
  if (replyTo === null) return { ...drafts, note: draft };
  const replies = { ...drafts.replies };
  if (draft === null) delete replies[replyTo];
  else
    Object.defineProperty(replies, replyTo, { value: draft, enumerable: true, configurable: true });
  return { ...drafts, replies };
}

export class ArtifactDraftStore {
  private readonly cache = new Map<string, Drafts>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dirty = new Map<string, Set<Slot>>();
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "length" | "key"> | null,
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
        if (
          valid(value.note) &&
          value.replies &&
          Object.values(value.replies).every((draft) => draft !== null && valid(draft))
        )
          drafts = {
            note: recover(value.note),
            replies: Object.fromEntries(
              Object.entries(value.replies).map(([id, draft]) => [id, recover(draft)!]),
            ),
          };
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
    try {
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage!.key(index);
        const slot = key && parseSlotKey(key);
        if (!slot || slot[0] !== id) continue;
        try {
          const draft = JSON.parse(this.storage!.getItem(key) ?? "null");
          if (valid(draft)) drafts = withDraft(drafts, slot[1], recover(draft));
        } catch {
          /* A damaged draft does not hide the other drafts. */
        }
      }
    } catch {
      /* Storage may be unavailable even when its object was accessible. */
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
      Number(hasMessageContent(drafts.note)) +
      Object.values(drafts.replies).filter(hasMessageContent).length
    );
  }
  update(id: string, patch: Partial<ArtifactDraft>, replyTo?: string): void {
    const next = { ...(this.get(id, replyTo) ?? blank()), ...patch };
    if (patch.operationKey === undefined) next.operationKey = undefined;
    this.commit(id, next, replyTo ?? null);
  }
  anchor(id: string, target: ArtifactTarget): boolean {
    if (hasMessageContent(this.get(id))) return false;
    this.update(id, { target, imported: false, mediaSnapshot: undefined });
    return true;
  }
  beginReply(id: string, replyTo: string, context: ArtifactMessageContext): void {
    if (hasMessageContent(this.get(id, replyTo))) return;
    this.update(id, { context }, replyTo);
  }
  clear(id: string, replyTo?: string): void {
    this.commit(id, null, replyTo ?? null);
  }
  clearIfCurrent(id: string, submitted: ArtifactDraft, replyTo?: string): boolean {
    // A save can finish after another composer has resumed this draft. Object
    // identity also preserves edits that return the text to its submitted value.
    if (this.get(id, replyTo) !== submitted) return false;
    this.clear(id, replyTo);
    return true;
  }
  pruneReplies(id: string, feedbackIds: ReadonlySet<string>): void {
    for (const feedbackId of Object.keys(this.load(id).replies))
      if (!feedbackIds.has(feedbackId)) this.clear(id, feedbackId);
  }
  private commit(id: string, draft: ArtifactDraft | null, replyTo: Slot): void {
    this.cache.set(id, withDraft(this.load(id), replyTo, draft));
    const dirty = this.dirty.get(id) ?? new Set<Slot>();
    dirty.add(replyTo);
    this.dirty.set(id, dirty);
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
    for (const replyTo of this.dirty.get(id) ?? []) {
      try {
        // Independent drafts cannot overwrite one another. A null value keeps
        // cleared drafts from being imported again from retained legacy keys.
        this.storage?.setItem(
          slotKey(id, replyTo),
          JSON.stringify(this.get(id, replyTo ?? undefined)),
        );
      } catch {
        /* Quota/private mode: retain the current in-memory draft. */
      }
    }
    this.dirty.delete(id);
  }
  sync(key: string | null): void {
    if (key === null) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      this.dirty.clear();
      this.cache.clear();
    } else {
      const slot = parseSlotKey(key);
      if (!slot || !this.cache.has(slot[0])) return;
      const [id, replyTo] = slot;
      // Let local typing finish its debounce; that later save will be shared.
      if (this.dirty.get(id)?.has(replyTo)) return;
      try {
        // Read the latest value: an event can arrive after another tab's write.
        const draft = JSON.parse(this.storage?.getItem(key) ?? "null");
        if (!valid(draft)) return;
        if (JSON.stringify(this.get(id, replyTo ?? undefined)) === JSON.stringify(draft)) return;
        this.cache.set(id, withDraft(this.load(id), replyTo, draft));
      } catch {
        return;
      }
    }
    for (const listener of this.listeners) listener();
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
  useSyncExternalStore(artifactDrafts.subscribe, () => hasMessageContent(artifactDrafts.get(id)));
export const useArtifactNoteOpen = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.get(id) !== null);
export const useArtifactDraftCount = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.count(id));
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea === browserStorage()) artifactDrafts.sync(event.key);
  });
  window.addEventListener("pagehide", () => artifactDrafts.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) artifactDrafts.flush();
  });
}

if (typeof window !== "undefined")
  window.setTimeout(() => {
    const referenced = new Set<string>();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(slotPrefix)) continue;
        const draft = JSON.parse(localStorage.getItem(key) ?? "null") as ArtifactDraft | null;
        for (const image of draft?.attachments ?? []) referenced.add(image.id);
        if (draft?.mediaSnapshot) referenced.add(draft.mediaSnapshot.id);
      }
      void draftImages.sweep(referenced);
    } catch {
      /* Without readable draft references, retain the binary drafts. */
    }
  }, 1000);
