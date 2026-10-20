import { useEffect, useState } from "react";
import { ATTACHMENT_LIMITS } from "../../../shared/attachments.ts";
import { t, useLocale } from "../i18n.ts";
import type { ImageEdit } from "../image-edit.ts";
import { type ImageOutput, imageSizeLabel, renderImageOutput } from "../image-output.ts";
import { Button } from "../ui.tsx";

export function ImageOptimization({
  source,
  edit,
  saving,
  onBack,
  onUse,
}: {
  source: ImageBitmap;
  edit: ImageEdit;
  saving: boolean;
  onBack: () => void;
  onUse: (output: ImageOutput) => void;
}) {
  useLocale();
  const [percent, setPercent] = useState(100);
  const [actualSize, setActualSize] = useState(false);
  const [result, setResult] = useState<{
    output: ImageOutput;
    url: string;
    percent: number;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    setError("");
    const timer = setTimeout(() => {
      void renderImageOutput(source, edit, percent / 100)
        .then((output) => {
          if (!active) return;
          url = URL.createObjectURL(output.blob);
          setResult({ output, url, percent });
        })
        .catch((cause) => {
          if (active)
            setError(cause instanceof Error ? cause.message : t("Unable to prepare preview"));
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, edit, percent]);
  const current = result?.percent === percent ? result : null;
  const fits = !!current && current.output.blob.size <= ATTACHMENT_LIMITS.bytes;
  return (
    <section aria-label={t("Image optimization")} className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        {t(
          "Resize the PNG to fit within 5 MiB. Inspect text and details before accepting it. Transparency is preserved.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t("Image size")}
          <input
            aria-label={t("Image size percent")}
            type="range"
            min="1"
            max="100"
            value={percent}
            disabled={saving}
            onChange={(event) => {
              setResult(null);
              setPercent(Number(event.target.value));
            }}
          />
          <span className="w-10 tabular-nums">{percent}%</span>
        </label>
        <Button
          type="button"
          aria-pressed={actualSize}
          onClick={() => setActualSize((value) => !value)}
        >
          {actualSize ? t("Fit preview") : t("View actual pixels")}
        </Button>
      </div>
      <p role="status" className="text-xs text-neutral-500" aria-live="polite">
        {error ||
          (current
            ? `${current.output.width} × ${current.output.height} · PNG · ${imageSizeLabel(current.output.blob.size)}${fits ? t(" · Ready to attach") : t(" · Above 5 MiB — reduce the size or go back to crop")}`
            : t("Preparing preview…"))}
      </p>
      <div className="max-h-[50dvh] min-h-24 overflow-auto border border-neutral-300 bg-neutral-100 p-2 dark:border-neutral-700 dark:bg-neutral-900">
        {current && (
          <img
            src={current.url}
            alt={t("Optimized attachment preview")}
            width={current.output.width}
            height={current.output.height}
            className={
              actualSize
                ? "block max-w-none"
                : "mx-auto block max-h-[45dvh] max-w-full object-contain"
            }
          />
        )}
      </div>
      <p className="text-xs text-neutral-500">
        {t(
          "This preview is the image that will be attached. Resizing can make small text harder to read.",
        )}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" disabled={saving} onClick={onBack}>
          {t("Back to crop and draw")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={saving || !fits || !!error}
          onClick={() => current && onUse(current.output)}
        >
          {saving ? t("Saving…") : t("Use optimized image")}
        </Button>
      </div>
    </section>
  );
}
