import {
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ATTACHMENT_LIMITS } from "../../../shared/attachments.ts";
import { type AppMessageKey, t as translateNow, useTranslation } from "../i18n.ts";
import {
  drawImageAnnotations,
  emptyImageHistory,
  type ImageCrop,
  type ImageDrawing,
  type ImageEdit,
  type ImagePoint,
  type ImageTool,
  imageCrop,
  imageHistory,
} from "../image-edit.ts";
import { type ImageOutput, renderImageOutput } from "../image-output.ts";
import { suspendKeys } from "../keys.ts";

import { Button } from "../ui.tsx";
import { ImageOptimization } from "./ImageOptimization.tsx";

type Gesture = {
  pointerId: number;
  tool: ImageTool;
  points: ImagePoint[];
  color: string;
  width: number;
};
const tools: { id: ImageTool; label: AppMessageKey }[] = [
  { id: "crop", label: "common.crop" },
  { id: "pen", label: "common.pen" },
  { id: "arrow", label: "common.arrow" },
  { id: "rectangle", label: "common.rectangle" },
];

export function ImageEditor({
  blob,
  startOptimizing = false,
  onCancel,
  onSave,
}: {
  blob: Blob;
  startOptimizing?: boolean;
  onCancel: () => void;
  onSave: (output: ImageOutput, crop: ImageCrop) => Promise<void>;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const activeGesture = useRef<Gesture | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [history, dispatch] = useReducer(imageHistory, undefined, emptyImageHistory);
  const [tool, setTool] = useState<ImageTool>("crop");
  const [color, setColor] = useState("#ef4444");
  const [width, setWidth] = useState(4);
  const [saving, setSaving] = useState(false);
  const [optimizing, setOptimizing] = useState(startOptimizing);
  const [error, setError] = useState("");
  const title = useId();
  const instructions = useId();
  const present = history.present;
  const crop =
    gesture?.tool === "crop"
      ? imageCrop(gesture.points[0]!, gesture.points.at(-1)!, size)
      : present.crop;
  const busy = saving || !size.width;
  const edit = (value: ImageEdit) => dispatch({ type: "edit", value });
  useLayoutEffect(() => {
    const node = dialog.current;
    const resume = suspendKeys();
    node?.showModal();
    return () => {
      node?.close();
      resume();
    };
  }, []);
  useEffect(() => {
    let current = true;
    dispatch({ type: "reset" });
    activeGesture.current = null;
    setGesture(null);
    setSize({ width: 0, height: 0 });
    setError("");
    setOptimizing(startOptimizing);
    void createImageBitmap(blob)
      .then((image) => {
        if (!current) {
          image.close();
          return;
        }
        if (
          !image.width ||
          !image.height ||
          image.width * image.height > ATTACHMENT_LIMITS.pixels
        ) {
          image.close();
          setError(translateNow("common.imagesMustBeAtMost20Megapixels"));
          return;
        }
        bitmap.current = image;
        setSize({ width: image.width, height: image.height });
      })
      .catch(() => {
        if (current) setError(translateNow("imageEditor.unableToOpenThisImage"));
      });
    return () => {
      current = false;
      bitmap.current?.close();
      bitmap.current = null;
    };
  }, [blob, startOptimizing]);
  useLayoutEffect(() => {
    if (!canvas.current || !bitmap.current) return;
    const ctx = canvas.current.getContext("2d")!;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap.current, 0, 0);
    drawImageAnnotations(ctx, present.drawings);
    if (gesture && gesture.tool !== "crop")
      drawImageAnnotations(ctx, [{ ...gesture, tool: gesture.tool }]);
    if (crop) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, size.width, crop.y);
      ctx.fillRect(0, crop.y + crop.height, size.width, size.height - crop.y - crop.height);
      ctx.fillRect(0, crop.y, crop.x, crop.height);
      ctx.fillRect(crop.x + crop.width, crop.y, size.width - crop.x - crop.width, crop.height);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
    }
  }, [size, crop, present.drawings, gesture]);
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // The border does not belong to the image's coordinate space.
    const scaleX = size.width / event.currentTarget.clientWidth;
    const scaleY = size.height / event.currentTarget.clientHeight;
    return {
      x: Math.round(
        Math.max(
          0,
          Math.min(
            size.width,
            (event.clientX - rect.left - event.currentTarget.clientLeft) * scaleX,
          ),
        ),
      ),
      y: Math.round(
        Math.max(
          0,
          Math.min(
            size.height,
            (event.clientY - rect.top - event.currentTarget.clientTop) * scaleY,
          ),
        ),
      ),
    };
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    const held = activeGesture.current;
    if (!held || held.pointerId !== event.pointerId) return;
    const end = point(event);
    const last = held.points.at(-1)!;
    if (last.x === end.x && last.y === end.y) return;
    const next = {
      ...held,
      points: held.tool === "pen" ? [...held.points, end] : [held.points[0]!, end],
    };
    activeGesture.current = next;
    setGesture(next);
  };
  const cancelGesture = () => {
    activeGesture.current = null;
    setGesture(null);
  };
  const save = async (accepted?: ImageOutput) => {
    if (!bitmap.current || saving || activeGesture.current) return;
    setSaving(true);
    setError("");
    try {
      const area = present.crop ?? { x: 0, y: 0, ...size };
      const result = accepted ?? (await renderImageOutput(bitmap.current, present));
      if (result.blob.size > ATTACHMENT_LIMITS.bytes) {
        setOptimizing(true);
        setSaving(false);
        return;
      }
      await onSave(result, area);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("imageEditor.unableToSaveImage"));
      setSaving(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={optimizing ? undefined : instructions}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        const field =
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, select, [contenteditable=true]");
        if (
          field ||
          optimizing ||
          busy ||
          activeGesture.current ||
          event.repeat ||
          event.altKey ||
          !(event.ctrlKey || event.metaKey)
        )
          return;
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          dispatch({ type: key === "y" || event.shiftKey ? "redo" : "undo" });
        }
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-5xl overflow-auto rounded-xl border border-neutral-300 bg-white p-4 text-neutral-900 r3-modal backdrop:bg-black/50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
    >
      <h2 id={title} className="mb-3 text-sm font-semibold">
        {optimizing ? t("imageEditor.optimizeImage") : t("common.editImage")}
      </h2>
      <div className={optimizing ? "hidden" : undefined}>
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy || !history.past.length}
              title={t("imageEditor.undoCtrlZ")}
              onClick={() => dispatch({ type: "undo" })}
            >
              {t("imageEditor.undo")}
            </Button>
            <Button
              type="button"
              disabled={busy || !history.future.length}
              title={t("imageEditor.redoCtrlShiftZ")}
              onClick={() => dispatch({ type: "redo" })}
            >
              {t("imageEditor.redo")}
            </Button>
            <Button
              type="button"
              disabled={busy || !present.drawings.length}
              onClick={() => edit({ ...present, drawings: [] })}
            >
              {t("imageEditor.clearDrawings")}
            </Button>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-3 border-y border-neutral-200 py-2 dark:border-neutral-800">
          <fieldset aria-label={t("imageEditor.imageTools")} className="flex flex-wrap gap-1">
            {tools.map((item) => (
              <Button
                type="button"
                key={item.id}
                disabled={busy}
                variant={tool === item.id ? "primary" : "default"}
                aria-pressed={tool === item.id}
                onClick={() => {
                  cancelGesture();
                  setTool(item.id);
                }}
              >
                {t(item.label)}
              </Button>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            {t("imageEditor.color")}
            <input
              type="color"
              aria-label={t("imageEditor.drawingColor")}
              value={color}
              disabled={busy}
              onChange={(event) => setColor(event.target.value)}
              className="h-8 w-9 cursor-pointer border border-neutral-300 bg-transparent p-0.5 dark:border-neutral-700"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            {t("imageEditor.stroke")}
            <select
              aria-label={t("imageEditor.strokeWidth")}
              value={width}
              disabled={busy}
              onChange={(event) => setWidth(Number(event.target.value))}
              className="h-8 border border-neutral-300 bg-white px-2 text-neutral-900 max-md:text-base dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            >
              {[2, 4, 8, 12].map((value) => (
                <option key={value} value={value}>
                  {t("common.px", { value: value })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p id={instructions} className="mb-3 text-xs text-neutral-500">
          {tool === "crop"
            ? t("imageEditor.dragToSelectAnAreaOrEnter")
            : t(
                tool === "pen"
                  ? "imageEditor.dragToDrawFreelyDrawingsAreIncluded"
                  : tool === "arrow"
                    ? "imageEditor.dragToPointToADetailDrawings"
                    : "imageEditor.dragToOutlineAnAreaDrawingsAre",
              )}
        </p>
        <canvas
          ref={canvas}
          width={size.width}
          height={size.height}
          aria-label={t("imageEditor.imageEditingArea")}
          tabIndex={0}
          className="mx-auto block max-h-[55dvh] max-w-full touch-none cursor-crosshair border border-neutral-300 object-contain dark:border-neutral-700"
          onPointerDown={(event) => {
            if (busy || activeGesture.current || !event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            const next = { pointerId: event.pointerId, tool, points: [point(event)], color, width };
            activeGesture.current = next;
            setGesture(next);
          }}
          onPointerMove={move}
          onPointerUp={(event) => {
            if (activeGesture.current?.pointerId !== event.pointerId) return;
            move(event);
            const held = activeGesture.current!;
            if (held.tool === "crop")
              edit({ ...present, crop: imageCrop(held.points[0]!, held.points.at(-1)!, size) });
            else {
              const drawing: ImageDrawing = {
                tool: held.tool,
                points: held.points,
                color: held.color,
                width: held.width,
              };
              edit({ ...present, drawings: [...present.drawings, drawing] });
            }
            cancelGesture();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={cancelGesture}
        />
        {size.width > 0 && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key} className="text-xs text-neutral-500">
                {key}
                <input
                  aria-label={t("imageEditor.crop", { key: key })}
                  type="number"
                  min={key === "x" || key === "y" ? 0 : 1}
                  max={key === "x" || key === "width" ? size.width : size.height}
                  className="ml-2 w-20 border border-neutral-300 bg-transparent px-2 py-1 text-neutral-900 max-md:text-base dark:border-neutral-700 dark:text-neutral-100"
                  disabled={saving}
                  value={(crop ?? { x: 0, y: 0, ...size })[key]}
                  onChange={(event) => {
                    const next = {
                      ...(present.crop ?? { x: 0, y: 0, ...size }),
                      [key]: Math.round(Number(event.target.value)),
                    };
                    next.x = Math.max(0, Math.min(size.width - 1, next.x));
                    next.y = Math.max(0, Math.min(size.height - 1, next.y));
                    next.width = Math.max(1, Math.min(size.width - next.x, next.width));
                    next.height = Math.max(1, Math.min(size.height - next.y, next.height));
                    edit({ ...present, crop: next });
                  }}
                />
              </label>
            ))}
            <Button
              type="button"
              disabled={saving || !present.crop}
              onClick={() => edit({ ...present, crop: null })}
            >
              {t("imageEditor.useWholeImage")}
            </Button>
          </div>
        )}
      </div>
      {optimizing && bitmap.current && size.width > 0 && (
        <ImageOptimization
          source={bitmap.current}
          edit={present}
          saving={saving}
          onBack={() => {
            setError("");
            setOptimizing(false);
          }}
          onUse={(output) => void save(output)}
        />
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" disabled={saving} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        {!optimizing && (
          <Button type="button" disabled={busy || !!gesture} onClick={() => setOptimizing(true)}>
            {t("imageEditor.optimizeImage")}
          </Button>
        )}
        {!optimizing && (
          <Button variant="primary" disabled={busy || !!gesture} onClick={() => void save()}>
            {saving ? t("common.saving") : t("imageEditor.useImage")}
          </Button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
