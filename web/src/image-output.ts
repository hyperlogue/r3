import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import { t } from "./i18n.ts";
import { drawImageAnnotations, type ImageEdit } from "./image-edit.ts";

export interface ImageOutput {
  blob: Blob;
  width: number;
  height: number;
}

export async function renderImageOutput(
  source: ImageBitmap,
  edit: ImageEdit,
  scale = 1,
): Promise<ImageOutput> {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1)
    throw new Error(t("imageOutput.chooseAnImageSizeBetween1And"));
  const area = edit.crop ?? { x: 0, y: 0, width: source.width, height: source.height };
  const width = Math.max(1, Math.round(area.width * scale));
  const height = Math.max(1, Math.round(area.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(width / area.width, height / area.height);
  ctx.translate(-area.x, -area.y);
  ctx.drawImage(source, 0, 0);
  drawImageAnnotations(ctx, edit.drawings);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (image) => (image ? resolve(image) : reject(new Error(t("common.unableToPrepareImage")))),
      "image/png",
    ),
  );
  return { blob, width, height };
}

export async function normalizeImage(file: Blob): Promise<ImageOutput> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error(t("imageOutput.chooseAPngJpegOrWebpImage"));
  if (file.size > ATTACHMENT_LIMITS.bytes) throw new Error(t("imageOutput.imagesMustBeAtMost5Mib"));
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > ATTACHMENT_LIMITS.pixels)
      throw new Error(t("common.imagesMustBeAtMost20Megapixels"));
    return await renderImageOutput(bitmap, { crop: null, drawings: [] });
  } finally {
    bitmap.close();
  }
}

export const imageSizeLabel = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
