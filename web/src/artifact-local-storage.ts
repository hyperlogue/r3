export type StorageValues = [string, string][];
export type StorageMutation =
  | { type: "set"; key: string; value: string }
  | { type: "remove"; key: string }
  | { type: "clear" };

export const ARTIFACT_STORAGE_LIMIT = 256 * 1024;
export const ARTIFACT_STORAGE_KEYS = 1024;
const PREFIX = "r3-artifact-storage:";
const CONTROL = "r3-artifact-storage-control";
const DELETED = "r3-artifact-storage-deleted:";
const MIGRATED = "r3-artifact-storage-migrated:";

function validateStorage(values: StorageValues, limit: number) {
  let bytes = 0;
  for (const [key, value] of values) bytes += 2 * (key.length + value.length);
  if (values.length > ARTIFACT_STORAGE_KEYS || bytes > limit)
    throw new DOMException("Artifact storage quota exceeded", "QuotaExceededError");
}

export function mutateStorage(
  values: StorageValues,
  operation: StorageMutation,
  limit = ARTIFACT_STORAGE_LIMIT,
): StorageValues {
  const next = new Map(values);
  if (operation.type === "clear") next.clear();
  else if (operation.type === "remove") next.delete(operation.key);
  else next.set(operation.key, operation.value);
  validateStorage([...next], limit);
  return [...next];
}

export class ArtifactLocalStorage {
  private memory = new Map<string, StorageValues>();
  private listeners = new Map<string, Set<(values: StorageValues) => void>>();
  private generations = new Map<string, number>();
  private epoch = 0;
  private suspended = false;
  private unavailable = new Set<string>();

  constructor(private readonly storage: () => Storage) {}

  private prefix(id: string) {
    return `${PREFIX}${encodeURIComponent(id)}:`;
  }

  snapshot(id: string): StorageValues {
    if (this.suspended) return [];
    if (this.unavailable.has(id)) return this.memory.get(id) ?? [];
    try {
      const storage = this.storage();
      const prefix = this.prefix(id);
      const values: StorageValues = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const value = storage.getItem(key);
        if (value !== null) values.push([key.slice(prefix.length), value]);
      }
      validateStorage(values, ARTIFACT_STORAGE_LIMIT);
      this.memory.set(id, values);
      if (!storage.getItem(MIGRATED + id)) {
        const legacy = storage.getItem(`r3-artifact-theme:${id}`);
        if (
          (legacy === "light" || legacy === "dark") &&
          !values.some(([key]) => key === "r3-showcase-theme")
        ) {
          validateStorage([...values, ["r3-showcase-theme", legacy]], ARTIFACT_STORAGE_LIMIT);
          values.push(["r3-showcase-theme", legacy]);
          storage.setItem(`${prefix}r3-showcase-theme`, legacy);
        }
        storage.setItem(MIGRATED + id, "1");
      }
      return values;
    } catch {
      this.unavailable.add(id);
      return this.memory.get(id) ?? [];
    }
  }

  private deletion(id: string) {
    try {
      return this.storage().getItem(DELETED + id);
    } catch {
      return null;
    }
  }

  bind(id: string, send: (values: StorageValues, acknowledged?: number) => void) {
    const generation = this.generations.get(id) ?? 0;
    const epoch = this.epoch;
    const control = this.authenticationEpoch();
    const deletion = this.deletion(id);
    let closed = false;
    const current = () =>
      !closed &&
      control === this.authenticationEpoch() &&
      !this.suspended &&
      epoch === this.epoch &&
      generation === (this.generations.get(id) ?? 0) &&
      deletion === this.deletion(id);
    const listener = (values: StorageValues) => {
      if (current()) send(values);
    };
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    return {
      snapshot: () => (current() ? this.snapshot(id) : []),
      write: (value: unknown) => {
        if (!current() || !value || typeof value !== "object") return;
        const message = value as {
          id?: unknown;
          operation?: { type?: unknown; key?: unknown; value?: unknown };
        };
        const operation = message.operation;
        if (!Number.isSafeInteger(message.id) || (message.id as number) < 1 || !operation) return;
        if (operation.type !== "clear" && operation.type !== "remove" && operation.type !== "set")
          return;
        if (operation.type !== "clear" && typeof operation.key !== "string") return;
        if (operation.type === "set" && typeof operation.value !== "string") return;
        let values: StorageValues;
        try {
          values = mutateStorage(this.snapshot(id), operation as StorageMutation);
        } catch {
          send(this.snapshot(id), message.id as number);
          return;
        }
        try {
          if (this.unavailable.has(id)) throw new Error("Storage unavailable");
          const storage = this.storage();
          const prefix = this.prefix(id);
          if (operation.type === "clear") {
            for (const [key] of this.snapshot(id)) storage.removeItem(prefix + key);
          } else if (operation.type === "remove")
            storage.removeItem(prefix + (operation.key as string));
          else storage.setItem(prefix + (operation.key as string), operation.value as string);
        } catch {
          this.unavailable.add(id);
        }
        this.memory.set(id, values);
        send(values, message.id as number);
        for (const other of listeners) if (other !== listener) other(values);
      },
      close: () => {
        closed = true;
        listeners.delete(listener);
        if (!listeners.size) this.listeners.delete(id);
      },
    };
  }

  changed(key: string | null, newValue?: string | null) {
    if (key === CONTROL) {
      this.suspended = newValue?.startsWith("suspended:") === true;
      this.memory.clear();
      return;
    }
    if (key?.startsWith(DELETED)) {
      const id = key.slice(DELETED.length);
      this.memory.delete(id);
      return;
    }
    for (const [id, listeners] of this.listeners) {
      if (key !== null && !key.startsWith(this.prefix(id))) continue;
      const values = this.snapshot(id);
      for (const listener of listeners) listener(values);
    }
  }

  forget(id: string) {
    const values = this.snapshot(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.memory.delete(id);
    try {
      const storage = this.storage();
      storage.setItem(DELETED + id, crypto.randomUUID());
      for (const [key] of values) storage.removeItem(this.prefix(id) + key);
    } catch {}
  }

  authenticationEpoch() {
    try {
      const value = this.storage().getItem(CONTROL);
      if (value?.startsWith("suspended:")) this.suspended = true;
      return value;
    } catch {
      return String(this.epoch);
    }
  }

  authenticationSuspended() {
    this.authenticationEpoch();
    return this.suspended;
  }

  suspend() {
    this.epoch++;
    this.suspended = true;
    this.memory.clear();
    try {
      const storage = this.storage();
      storage.setItem(CONTROL, `suspended:${crypto.randomUUID()}`);
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) if (key?.startsWith(PREFIX)) storage.removeItem(key);
    } catch {}
  }

  resume(expected: string | null) {
    if (this.authenticationEpoch() !== expected) return;
    if (!this.suspended) return;
    this.suspended = false;
    try {
      this.storage().setItem(CONTROL, `active:${crypto.randomUUID()}`);
    } catch {}
  }
}

export const artifactLocalStorage = new ArtifactLocalStorage(() => localStorage);
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) =>
    artifactLocalStorage.changed(event.key, event.newValue),
  );
