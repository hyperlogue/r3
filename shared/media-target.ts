import type { MediaBox } from "./artifacts.ts";

export const FULL_MEDIA_BOX: MediaBox = { x: 0, y: 0, width: 1, height: 1 };
export const wholeMediaBox = (box: MediaBox) =>
  box.x === 0 && box.y === 0 && box.width === 1 && box.height === 1;

export function mediaTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

// Conservative static-image support. Animated formats stay in their existing
// preview until frame targeting for animation has its own contract.
export function targetableMedia(mediaType: string): "image" | "video" | null {
  const type = mediaType.split(";")[0];
  if (type.startsWith("video/")) return "video";
  return ["image/png", "image/jpeg", "image/webp"].includes(type) ? "image" : null;
}

export function animatedImage(bytes: Uint8Array, mediaType: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (mediaType.split(";")[0] === "image/png") {
    for (let at = 8; at + 12 <= bytes.length; ) {
      if (["acTL", "fcTL", "fdAT"].includes(tag(at + 4))) return true;
      at += view.getUint32(at) + 12;
    }
  } else if (mediaType.split(";")[0] === "image/webp") {
    for (let at = 12; at + 8 <= bytes.length; ) {
      if (["ANIM", "ANMF"].includes(tag(at))) return true;
      const length = view.getUint32(at + 4, true);
      at += 8 + length + (length % 2);
    }
  }
  return false;
}
