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
  comments: Record<string, ArtifactDraft>;
}
const empty = (): Drafts => ({ note: null, comments: {} });
const blank = (): ArtifactDraft => ({
  body: "",
  target: { kind: "artifact" },
  context: { versionSeq: null, representation: null },
});
const prefix = "r3-artifact-draft-";
const slotPrefix = "r3-artifact-draft-slot-";
type Slot = string | null;
const slotKey = (id: string, commentTo: Slot) => slotPrefix + JSON.stringify([id, commentTo]);
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
function withDraft(drafts: Drafts, commentTo: Slot, draft: ArtifactDraft | null): Drafts {
  if (commentTo === null) return { ...drafts, note: draft };
  const comments = { ...drafts.comments };
  if (draft === null) delete comments[commentTo];
  else
    Object.defineProperty(comments, commentTo, {
      value: draft,
      enumerable: true,
      configurable: true,
    });
  return { ...drafts, comments };
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
        const value = JSON.parse(saved) as Drafts & { replies?: Drafts["comments"] };
        // Older aggregate drafts predate Comment terminology. Slot keys are unchanged.
        value.comments ??= value.replies ?? {};
        if (
          valid(value.note) &&
          value.comments &&
          Object.values(value.comments).every((draft) => draft !== null && valid(draft))
        )
          drafts = {
            note: recover(value.note),
            comments: Object.fromEntries(
              Object.entries(value.comments).map(([id, draft]) => [id, recover(draft)!]),
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
          for (const [discussionId, body] of Object.entries(
            legacy.comments ?? legacy.replies ?? {},
          ))
            if (typeof body === "string" && body.trim())
              Object.defineProperty(drafts.comments, discussionId, {
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

  get(id: string, commentTo?: string): ArtifactDraft | null {
    const drafts = this.load(id);
    return commentTo ? (drafts.comments[commentTo] ?? null) : drafts.note;
  }
  has(id: string): boolean {
    return this.count(id) > 0;
  }
  count(id: string): number {
    const drafts = this.load(id);
    return (
      Number(hasMessageContent(drafts.note)) +
      Object.values(drafts.comments).filter(hasMessageContent).length
    );
  }
  update(id: string, patch: Partial<ArtifactDraft>, commentTo?: string): void {
    const next = { ...(this.get(id, commentTo) ?? blank()), ...patch };
    if (patch.operationKey === undefined) next.operationKey = undefined;
    this.commit(id, next, commentTo ?? null);
  }
  anchor(id: string, target: ArtifactTarget): boolean {
    if (hasMessageContent(this.get(id))) return false;
    this.update(id, { target, imported: false, mediaSnapshot: undefined });
    return true;
  }
  beginComment(id: string, commentTo: string, context: ArtifactMessageContext): void {
    if (hasMessageContent(this.get(id, commentTo))) return;
    this.update(id, { context }, commentTo);
  }
  clear(id: string, commentTo?: string): void {
    this.commit(id, null, commentTo ?? null);
  }
  clearIfCurrent(id: string, submitted: ArtifactDraft, commentTo?: string): boolean {
    // A save can finish after another composer has resumed this draft. Object
    // identity also preserves edits that return the text to its submitted value.
    if (this.get(id, commentTo) !== submitted) return false;
    this.clear(id, commentTo);
    return true;
  }
  pruneComments(id: string, discussionIds: ReadonlySet<string>): void {
    for (const discussionId of Object.keys(this.load(id).comments))
      if (!discussionIds.has(discussionId)) this.clear(id, discussionId);
  }
  private commit(id: string, draft: ArtifactDraft | null, commentTo: Slot): void {
    this.cache.set(id, withDraft(this.load(id), commentTo, draft));
    const dirty = this.dirty.get(id) ?? new Set<Slot>();
    dirty.add(commentTo);
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
    for (const commentTo of this.dirty.get(id) ?? []) {
      try {
        // Independent drafts cannot overwrite one another. A null value keeps
        // cleared drafts from being imported again from retained legacy keys.
        this.storage?.setItem(
          slotKey(id, commentTo),
          JSON.stringify(this.get(id, commentTo ?? undefined)),
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
      const [id, commentTo] = slot;
      // Let local typing finish its debounce; that later save will be shared.
      if (this.dirty.get(id)?.has(commentTo)) return;
      try {
        // Read the latest value: an event can arrive after another tab's write.
        const draft = JSON.parse(this.storage?.getItem(key) ?? "null");
        if (!valid(draft)) return;
        if (JSON.stringify(this.get(id, commentTo ?? undefined)) === JSON.stringify(draft)) return;
        this.cache.set(id, withDraft(this.load(id), commentTo, draft));
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
export const useArtifactDraft = (id: string, commentTo?: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.get(id, commentTo));
export const useHasArtifactDraft = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.has(id));
export const useHasArtifactNote = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => hasMessageContent(artifactDrafts.get(id)));
export const useArtifactNoteOpen = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => artifactDrafts.get(id) !== null);
// Media viewers follow the frame's lifetime without subscribing to typed text.
export const useArtifactMediaDraftFrame = (id: string) =>
  useSyncExternalStore(artifactDrafts.subscribe, () => {
    const draft = artifactDrafts.get(id);
    return draft?.target.kind === "media" ? (draft.mediaSnapshot?.id ?? null) : null;
  });
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
