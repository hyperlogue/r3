import {
  ATTACHMENT_LIMITS,
  type AttachmentCapture,
  type AttachmentInput,
} from "../../shared/attachments.ts";
import { t } from "./i18n.ts";
import { type ImageOutput, normalizeImage } from "./image-output.ts";

export interface DraftAttachment {
  id: string;
  width: number;
  height: number;
  byteLength: number;
  mediaType: "image/png" | "image/jpeg";
  capture?: AttachmentCapture;
  pending?: boolean;
  error?: string;
}
export type ImageEpoch = { generation: number; epoch: number | null };
interface ImageRecord {
  id: string;
  artifactId: string;
  blob: Blob;
  createdAt: number;
}
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error(t("attachmentDrafts.imageStorageFailed")));
  });

// localStorage holds draft references; only this store persists binary data.
// Unreferenced blobs are swept after a grace period so another tab can finish
// persisting its draft. Referenced drafts are never evicted for cache space.
export class DraftImageStore {
  private opening: Promise<IDBDatabase> | undefined;
  private memory = new Map<string, ImageRecord>();
  private generation = 0;
  private suspended = false;
  private channel: BroadcastChannel | null;
  constructor(private readonly name = "r3-draft-images") {
    this.channel =
      typeof BroadcastChannel !== "undefined" && typeof window !== "undefined"
        ? new BroadcastChannel(name)
        : null;
    if (this.channel)
      this.channel.onmessage = ({ data }: MessageEvent<{ artifactId?: string }>) => {
        this.generation++;
        if (!data.artifactId) this.suspended = true;
        for (const [id, record] of this.memory)
          if (!data.artifactId || record.artifactId === data.artifactId) this.memory.delete(id);
        window.dispatchEvent(new CustomEvent("r3-images-cleared", { detail: data.artifactId }));
      };
  }
  private open(): Promise<IDBDatabase> {
    this.opening ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(this.name, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("images", { keyPath: "id" });
        opening.result.createObjectStore("state");
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => {
        this.opening = undefined;
        reject(opening.error);
      };
      opening.onblocked = () =>
        reject(new Error(t("attachmentDrafts.imageStorageIsBlockedByAnotherTab")));
    });
    return this.opening;
  }
  async epoch(): Promise<ImageEpoch> {
    const generation = this.generation;
    try {
      const db = await this.open();
      return {
        generation,
        epoch: (await request(db.transaction("state").objectStore("state").get("epoch"))) ?? 0,
      };
    } catch {
      return { generation, epoch: null };
    }
  }
  async authenticationSuspended(): Promise<boolean> {
    try {
      const db = await this.open();
      const suspended = await request(
        db.transaction("state").objectStore("state").get("suspended"),
      );
      return this.suspended || Boolean(suspended);
    } catch {
      // Unreadable logout state cannot authorize an older HTML snapshot.
      return true;
    }
  }
  async put(
    artifactId: string,
    blob: Blob,
    id: string = crypto.randomUUID(),
    ticket?: ImageEpoch,
  ): Promise<{ id: string; persisted: boolean }> {
    if (this.suspended) throw new Error(t("attachmentDrafts.signInAgainBeforeAttachingImages"));
    const captured = ticket ?? (await this.epoch());
    const generation = captured.generation;
    let revoked = false;
    const record = { id, artifactId, blob, createdAt: Date.now() };
    try {
      const db = await this.open();
      const tx = db.transaction(["images", "state"], "readwrite");
      const completion = done(tx);
      const epoch = tx.objectStore("state").get("epoch");
      const state = tx.objectStore("state").get("suspended");
      state.onsuccess = () => {
        if (
          state.result ||
          (captured.epoch !== null && captured.epoch !== (epoch.result ?? 0)) ||
          generation !== this.generation ||
          this.suspended
        ) {
          revoked = true;
          tx.abort();
        } else tx.objectStore("images").put(record);
      };
      await completion;
      return { id, persisted: true };
    } catch {
      if (revoked || generation !== this.generation || this.suspended)
        throw new Error(t("attachmentDrafts.imageAttachmentWasCancelled"));
      this.memory.set(id, record);
      return { id, persisted: false };
    }
  }
  async get(id: string): Promise<Blob> {
    if (this.suspended) throw new Error(t("attachmentDrafts.signInAgainToOpenDraftImages"));
    const held = this.memory.get(id);
    const generation = this.generation;
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch {
      if (held && generation === this.generation && !this.suspended) return held.blob;
      throw new Error(t("attachmentDrafts.draftImageStorageIsUnavailable"));
    }
    const tx = db.transaction(["images", "state"]);
    const [record, suspended] = await Promise.all([
      request(tx.objectStore("images").get(id)) as Promise<ImageRecord | undefined>,
      request(tx.objectStore("state").get("suspended")),
    ]);
    if (suspended || generation !== this.generation)
      throw new Error(t("attachmentDrafts.signInAgainToOpenDraftImages"));
    if (held) return held.blob;
    if (!record) throw new Error(t("attachmentDrafts.thisDraftImageIsUnavailableRemoveIt"));
    return record.blob;
  }
  async clear(artifactId?: string) {
    this.generation++;
    if (!artifactId) this.suspended = true;
    for (const [id, record] of this.memory)
      if (!artifactId || record.artifactId === artifactId) this.memory.delete(id);
    this.channel?.postMessage({ artifactId });
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("r3-images-cleared", { detail: artifactId }));
    try {
      const db = await this.open();
      const tx = db.transaction(["images", "state"], "readwrite");
      const completion = done(tx);
      const epoch = tx.objectStore("state").get("epoch");
      epoch.onsuccess = () => tx.objectStore("state").put((epoch.result ?? 0) + 1, "epoch");
      if (!artifactId) {
        tx.objectStore("state").put(true, "suspended");
        tx.objectStore("images").clear();
      } else {
        const cursor = tx.objectStore("images").openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            if (item.value.artifactId === artifactId) item.delete();
            item.continue();
          }
        };
      }
      await completion;
    } catch {
      /* Memory has still been revoked when persistence is unavailable. */
    }
  }
  async resume(ticket?: ImageEpoch) {
    const captured = ticket ?? (await this.epoch());
    const generation = captured.generation;
    try {
      const db = await this.open();
      if (generation !== this.generation) return;
      const tx = db.transaction("state", "readwrite");
      const completion = done(tx);
      let accepted = false;
      const epoch = tx.objectStore("state").get("epoch");
      epoch.onsuccess = () => {
        if (captured.epoch === (epoch.result ?? 0) && generation === this.generation) {
          tx.objectStore("state").delete("suspended");
          accepted = true;
        }
      };
      await completion;
      if (!accepted) return;
    } catch {
      /* In-memory drafts remain usable with a visible persistence warning. */
    }
    if (generation === this.generation) this.suspended = false;
  }
  async sweep(referenced: ReadonlySet<string>) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, record] of this.memory)
      if (record.createdAt < cutoff && !referenced.has(id)) this.memory.delete(id);
    try {
      const db = await this.open();
      const tx = db.transaction("images", "readwrite");
      const completion = done(tx);
      const cursor = tx.objectStore("images").openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) {
          if (item.value.createdAt < cutoff && !referenced.has(item.value.id)) item.delete();
          item.continue();
        }
      };
      await completion;
    } catch {
      /* Cleanup retries on the next visit. */
    }
  }
}
export const draftImages = new DraftImageStore();

export class ImageOptimizationRequired extends Error {
  constructor(readonly ticket: ImageEpoch) {
    super("The prepared PNG exceeds 5 MiB. Crop or resize it in the optimization preview.");
  }
}

// Only normalized/editor output reaches this path. Keep the accepted preview's
// exact bytes instead of encoding them a second time before saving.
export async function saveDraftImageOutput(
  artifactId: string,
  output: ImageOutput,
  capture?: AttachmentCapture,
  ticket?: ImageEpoch,
) {
  if (
    output.blob.type !== "image/png" ||
    output.blob.size > ATTACHMENT_LIMITS.bytes ||
    output.width < 1 ||
    output.height < 1 ||
    output.width * output.height > ATTACHMENT_LIMITS.pixels
  )
    throw new Error(t("attachmentDrafts.chooseAPngOutputOfAtMost"));
  const saved = await draftImages.put(artifactId, output.blob, undefined, ticket);
  return {
    attachment: {
      id: saved.id,
      width: output.width,
      height: output.height,
      byteLength: output.blob.size,
      mediaType: "image/png",
      ...(capture ? { capture } : {}),
    } satisfies DraftAttachment,
    persisted: saved.persisted,
  };
}

export async function prepareDraftImage(
  artifactId: string,
  file: Blob,
  capture?: AttachmentCapture,
) {
  const epoch = await draftImages.epoch();
  const output = await normalizeImage(file);
  if (output.blob.size > ATTACHMENT_LIMITS.bytes) throw new ImageOptimizationRequired(epoch);
  return saveDraftImageOutput(artifactId, output, capture, epoch);
}

export async function draftAttachmentInputs(
  images: DraftAttachment[] = [],
): Promise<AttachmentInput[]> {
  return Promise.all(
    images.map(async (image) => {
      const blob = await draftImages.get(image.id);
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error(t("attachmentDrafts.unableToReadImage")));
        reader.readAsDataURL(blob);
      });
      return {
        base64,
        mediaType: image.mediaType,
        ...(image.capture ? { capture: image.capture } : {}),
      };
    }),
  );
}
