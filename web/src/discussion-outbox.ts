import type { ArtifactDraft } from "./artifact-drafts.ts";

export const outboxPrefix = "r3-discussion-outbox-";
export interface OutgoingMessage {
  id: string;
  artifactId: string;
  threadId?: string;
  draft: ArtifactDraft;
  createdAt: number;
  attempts: number;
  nextAttempt: number;
  error?: string;
  failed?: boolean;
}
export function retryableMessageError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))
  );
}
// Each operation owns one key: concurrent tabs never overwrite another message.
// Persist before clearing the composer. Storage failure leaves the draft intact.
export class DiscussionOutbox {
  private items: OutgoingMessage[] = [];
  generation = 0;
  private listeners = new Set<() => void>();
  constructor(private storage: Storage | null) {
    try {
      this.reload();
    } catch {
      this.storage = null;
    }
  }
  snapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  reload = () => {
    const items: OutgoingMessage[] = [];
    if (this.storage)
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)!;
        if (!key.startsWith(outboxPrefix)) continue;
        try {
          const item = JSON.parse(this.storage.getItem(key)!) as OutgoingMessage;
          if (
            item.id &&
            item.artifactId &&
            typeof item.draft?.body === "string" &&
            item.draft.operationKey === item.id
          )
            items.push(item);
        } catch {
          /* Leave unreadable local evidence untouched. */
        }
      }
    this.items = items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const listener of this.listeners) listener();
  };
  put(item: OutgoingMessage) {
    if (!this.storage) throw new Error("Browser storage is unavailable. Your draft has been kept.");
    this.storage.setItem(outboxPrefix + item.id, JSON.stringify(item));
    this.reload();
  }
  enqueue(
    artifactId: string,
    draft: ArtifactDraft,
    threadId?: string,
    generation = this.generation,
  ) {
    if (generation !== this.generation)
      throw new Error("Message submission was cancelled. Your draft has been kept.");
    const id = draft.operationKey ?? crypto.randomUUID();
    this.put({
      id,
      artifactId,
      threadId,
      draft: { ...draft, operationKey: id },
      createdAt: Date.now(),
      attempts: 0,
      nextAttempt: 0,
    });
  }
  remove(id: string) {
    this.storage?.removeItem(outboxPrefix + id);
    this.reload();
  }
  retry(id: string) {
    const item = this.items.find((item) => item.id === id);
    if (item) this.put({ ...item, failed: false, error: undefined, nextAttempt: 0 });
  }
  reject(item: OutgoingMessage, error: unknown) {
    if (!this.storage?.getItem(outboxPrefix + item.id)) return;
    const attempts = item.attempts + 1;
    this.put({
      ...item,
      attempts,
      failed: !retryableMessageError(error),
      error: error instanceof Error ? error.message : String(error),
      nextAttempt: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)),
    });
  }
  clear(artifactId?: string) {
    this.generation++;
    for (const item of this.items)
      if (!artifactId || item.artifactId === artifactId)
        this.storage?.removeItem(outboxPrefix + item.id);
    this.reload();
  }
}
function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
export const discussionOutbox = new DiscussionOutbox(browserStorage());
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key.startsWith(outboxPrefix)) discussionOutbox.reload();
  });
  window.addEventListener("r3-images-cleared", (event) =>
    discussionOutbox.clear((event as CustomEvent<string | undefined>).detail),
  );
}
