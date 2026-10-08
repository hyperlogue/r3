export const ATTACHMENT_LIMITS = {
  count: 4,
  bytes: 5 * 1024 * 1024,
  pixels: 20_000_000,
  requestBytes: 40 * 1024 * 1024,
} as const;

export const imagePlaceholder = (number: number): string => `[image${number}]`;

export interface AttachmentCapture {
  versionSeq: number;
  path: string;
  route?: string;
  viewport: { width: number; height: number };
  // Pixels in the frozen preview image, before cropping or annotation.
  crop: { x: number; y: number; width: number; height: number };
}

export interface ArtifactAttachment {
  id: string;
  artifactId: string;
  hash: string;
  mediaType: "image/png" | "image/jpeg";
  byteLength: number;
  width: number;
  height: number;
  capture?: AttachmentCapture;
}

export type AttachmentInput =
  | { id: string }
  | { base64: string; mediaType: "image/png" | "image/jpeg"; capture?: AttachmentCapture };

export const attachmentPath = (artifactId: string, id: string) =>
  `/api/artifacts/${encodeURIComponent(artifactId)}/attachments/${encodeURIComponent(id)}`;

export function hasMessageContent(
  message: { body: string; attachments?: readonly unknown[] } | null | undefined,
): boolean {
  return !!message && (!!message.body.trim() || !!message.attachments?.length);
}
