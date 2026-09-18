export interface ReadingPosition {
  x: number;
  y: number;
}
const STORAGE_KEY = "r3-reading-positions-1";
const LIMIT = 128;
export const readingKey = (artifact: string, version: number, path: string, view: string) =>
  JSON.stringify([artifact, version, path, view]);
export function isReadingPosition(value: unknown): value is ReadingPosition {
  if (!value || typeof value !== "object") return false;
  const { x, y } = value as ReadingPosition;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= 32_000_000 &&
    y <= 32_000_000
  );
}

// Reading metadata only; document-byte caching has its own immutable identity.
export class ReadingPositions {
  private readonly positions = new Map<string, ReadingPosition>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly storage: () => Pick<Storage, "getItem" | "setItem"> | null) {
    try {
      const entries: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(entries))
        for (const entry of entries.slice(-LIMIT)) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && isReadingPosition(entry[1]))
            this.positions.set(entry[0], { x: entry[1].x, y: entry[1].y });
        }
    } catch {
      /* Storage is optional. */
    }
  }
  get(key: string) {
    return this.positions.get(key);
  }
  set(key: string, point: ReadingPosition) {
    if (!isReadingPosition(point)) return;
    this.positions.delete(key);
    this.positions.set(key, { x: point.x, y: point.y });
    while (this.positions.size > LIMIT) this.positions.delete(this.positions.keys().next().value!);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      this.storage()?.setItem(STORAGE_KEY, JSON.stringify([...this.positions]));
    } catch {
      /* Storage is optional. */
    }
  }
  forget(artifact: string) {
    for (const key of this.positions.keys())
      if (key.startsWith(`[${JSON.stringify(artifact)},`)) this.positions.delete(key);
    this.flush();
  }
}
export const readingPositions = new ReadingPositions(() => sessionStorage);
if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => readingPositions.flush());
