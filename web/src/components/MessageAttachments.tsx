import { type ClipboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  type ArtifactAttachment,
  ATTACHMENT_LIMITS,
  type AttachmentInput,
  imagePlaceholder,
} from "../../../shared/attachments.ts";
import { type ArtifactPageData, useArtifactClient } from "../artifact-ui-context.tsx";
import {
  type DraftAttachment,
  draftAttachmentInputs,
  draftImages,
  ImageOptimizationRequired,
  prepareDraftImage,
  saveDraftImageOutput,
} from "../attachment-drafts.ts";
import { mapImageCrop } from "../image-edit.ts";
import { type ImageInsertion, insertImagePlaceholders } from "../image-placeholders.ts";
import { suspendKeys } from "../keys.ts";
import { Button, PaperclipIcon, PencilIcon, TrashIcon } from "../ui.tsx";
import { ImageEditor } from "./ImageEditor.tsx";
import { useImagePreparation } from "./ImagePreparation.tsx";

export type EditableImage = (DraftAttachment | ArtifactAttachment) & {
  pending?: boolean;
  error?: string;
};
type ChangeImages = (
  change: (images: EditableImage[]) => EditableImage[],
  insertion?: ImageInsertion,
) => void;
export async function imageBlob(
  image: EditableImage,
  attachment: ArtifactPageData["attachment"],
): Promise<Blob> {
  if (image.error) throw new Error(image.error);
  if (image.pending) throw new Error("Wait for the image to finish processing");
  return "hash" in image
    ? (await attachment(image.artifactId, image.id)).blob()
    : draftImages.get(image.id);
}
export async function editableImageInputs(images: EditableImage[]): Promise<AttachmentInput[]> {
  return Promise.all(
    images.map(async (image) => {
      if (image.pending || image.error) throw new Error("Remove unfinished images before posting");
      return "hash" in image ? { id: image.id } : (await draftAttachmentInputs([image]))[0]!;
    }),
  );
}
function AttachmentImage({
  artifactId,
  image,
  onOpen,
}: {
  artifactId: string;
  image: EditableImage;
  onOpen: (blob: Blob) => void;
}) {
  const artifactApi = useArtifactClient();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const held = useRef<Blob | null>(null);
  useEffect(() => {
    let alive = true;
    let url = "";
    setUrl("");
    setError("");
    if (!image.pending)
      void imageBlob(image, artifactApi.attachment)
        .then((blob) => {
          if (alive) {
            held.current = blob;
            url = URL.createObjectURL(blob);
            setUrl(url);
          }
        })
        .catch((error) => {
          if (alive) setError(error.message);
        });
    const clear = (event: Event) => {
      const cleared = (event as CustomEvent<string | undefined>).detail;
      if (cleared && cleared !== artifactId) return;
      alive = false;
      held.current = null;
      if (url) URL.revokeObjectURL(url);
      setUrl("");
    };
    window.addEventListener("r3-images-cleared", clear);
    return () => {
      window.removeEventListener("r3-images-cleared", clear);
      alive = false;
      held.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [image, artifactId, artifactApi]);
  return (
    <div className="min-w-0">
      {url ? (
        <button
          type="button"
          aria-label="Open attached image"
          className="block w-full overflow-hidden border border-neutral-300 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900"
          onClick={() => held.current && onOpen(held.current)}
        >
          <img
            src={url}
            alt="Thread attachment"
            width={image.width}
            height={image.height}
            className="h-24 w-full object-contain"
          />
        </button>
      ) : (
        <p role={error ? "alert" : "status"} className="p-2 text-xs text-neutral-500">
          {error || (image.pending ? "Preparing image…" : "Loading image…")}
        </p>
      )}
    </div>
  );
}

export function MessageAttachments({
  artifactId,
  images = [],
  onChange,
  disabled = false,
}: {
  artifactId: string;
  images?: EditableImage[];
  onChange?: ChangeImages;
  disabled?: boolean;
}) {
  const artifactApi = useArtifactClient();
  const [opened, setOpened] = useState<{ image: EditableImage; blob: Blob } | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [viewUrl, setViewUrl] = useState("");
  useEffect(() => {
    if (!opened) return;
    const url = URL.createObjectURL(opened.blob);
    const resume = suspendKeys();
    setViewUrl(url);
    dialog.current?.showModal();
    return () => {
      URL.revokeObjectURL(url);
      dialog.current?.close();
      resume();
    };
  }, [opened]);
  useEffect(() => {
    const clear = (event: Event) => {
      const cleared = (event as CustomEvent<string | undefined>).detail;
      if (cleared && cleared !== artifactId) return;
      setOpened(null);
      setEditing(false);
    };
    window.addEventListener("r3-images-cleared", clear);
    return () => window.removeEventListener("r3-images-cleared", clear);
  }, [artifactId]);
  if (!images.length) return null;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 py-2">
        {images.map((image, index) => (
          <div key={image.id}>
            <p className="mb-1 font-mono text-xs text-neutral-500">{imagePlaceholder(index + 1)}</p>
            <AttachmentImage
              artifactId={artifactId}
              image={image}
              onOpen={(blob) => setOpened({ image, blob })}
            />
            {onChange && (
              <div className="mt-1 flex gap-2">
                <Button
                  type="button"
                  className="size-7 shrink-0 justify-center p-0! max-md:size-9"
                  aria-label="Edit image"
                  title="Edit image"
                  disabled={disabled || image.pending || !!image.error}
                  onClick={() => {
                    void imageBlob(image, artifactApi.attachment)
                      .then((blob) => {
                        setOpened({ image, blob });
                        setEditing(true);
                      })
                      .catch((error) => setError(error.message));
                  }}
                >
                  <PencilIcon />
                </Button>
                <Button
                  type="button"
                  className="size-7 shrink-0 justify-center p-0! max-md:size-9"
                  aria-label="Remove image"
                  title="Remove image"
                  disabled={disabled}
                  onClick={() => onChange((items) => items.filter((item) => item.id !== image.id))}
                >
                  <TrashIcon />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {opened && !editing && (
        <dialog
          ref={dialog}
          aria-label="Attached image"
          onKeyDown={(event) => event.stopPropagation()}
          onCancel={() => setOpened(null)}
          className="m-auto max-h-[90dvh] max-w-[95vw] overflow-auto rounded-xl border border-neutral-300 bg-white p-4 r3-modal backdrop:bg-black/50 dark:bg-neutral-950"
        >
          <img
            src={viewUrl}
            alt="Thread attachment at full size"
            className="max-h-[75dvh] max-w-full object-contain"
          />
          <div className="mt-3 flex justify-end gap-3">
            <a
              className="text-sm underline"
              href={viewUrl}
              download={`attachment.${opened.blob.type === "image/jpeg" ? "jpg" : "png"}`}
            >
              Download
            </a>
            <Button type="button" onClick={() => setOpened(null)}>
              Close
            </Button>
          </div>
        </dialog>
      )}
      {opened && editing && onChange && (
        <ImageEditor
          blob={opened.blob}
          onCancel={() => {
            setOpened(null);
            setEditing(false);
          }}
          onSave={async (output, crop) => {
            const capture = opened.image.capture
              ? {
                  ...opened.image.capture,
                  crop: mapImageCrop(crop, opened.image, opened.image.capture.crop),
                }
              : undefined;
            const { attachment, persisted } = await saveDraftImageOutput(
              artifactId,
              output,
              capture,
            );
            onChange((items) =>
              items.map((item) => (item.id === opened.image.id ? attachment : item)),
            );
            if (!persisted)
              setError("Image is available in this tab, but could not be saved for reload.");
            setOpened(null);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

export function useAttachmentInput(
  artifactId: string,
  images: EditableImage[],
  onChange: ChangeImages,
  disabled: boolean,
  textarea: RefObject<HTMLTextAreaElement | null>,
) {
  const current = useRef({ images, onChange, disabled });
  current.current = { images, onChange, disabled };
  const [notice, setNotice] = useState("");
  const optimize = useImagePreparation();
  const input = useRef<HTMLInputElement>(null);
  const add = async (files: Blob[], text = "") => {
    if (!files.length) return;
    if (current.current.disabled) return;
    if (current.current.images.length + files.length > ATTACHMENT_LIMITS.count) {
      setNotice("A message can contain at most four images");
      return;
    }
    setNotice("");
    const change = current.current.onChange;
    const node = textarea.current;
    const insertion = node
      ? { start: node.selectionStart, end: node.selectionEnd, text }
      : undefined;
    const inserted = node
      ? insertImagePlaceholders(
          node.value,
          current.current.images.length + 1,
          files.length,
          insertion,
        )
      : null;
    const pending = files.map((file) => ({ file, id: crypto.randomUUID() }));
    let accepted = true;
    flushSync(() =>
      change((items) => {
        if (items.length + files.length > ATTACHMENT_LIMITS.count) {
          accepted = false;
          return items;
        }
        return [
          ...items,
          ...pending.map(({ file, id }) => ({
            id,
            width: 0,
            height: 0,
            byteLength: file.size,
            mediaType: "image/png" as const,
            pending: true,
          })),
        ];
      }, insertion),
    );
    if (!accepted) {
      setNotice("A message can contain at most four images");
      return;
    }
    if (node?.isConnected && inserted) {
      node.focus({ preventScroll: true });
      node.setSelectionRange(inserted.caret, inserted.caret);
    }
    for (const { file, id } of pending) {
      try {
        const { attachment, persisted } = await prepareDraftImage(artifactId, file);
        change((items) => items.map((item) => (item.id === id ? attachment : item)));
        if (!persisted)
          setNotice("Image is available in this tab, but could not be saved for reload.");
      } catch (error) {
        let failure = error;
        if (error instanceof ImageOptimizationRequired && optimize) {
          const output = await optimize(file);
          if (!output) {
            change((items) => items.filter((item) => item.id !== id));
            continue;
          }
          try {
            const { attachment, persisted } = await saveDraftImageOutput(
              artifactId,
              output,
              undefined,
              error.ticket,
            );
            change((items) => items.map((item) => (item.id === id ? attachment : item)));
            if (!persisted)
              setNotice("Image is available in this tab, but could not be saved for reload.");
            continue;
          } catch (cause) {
            failure = cause;
          }
        }
        change((items) =>
          items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  pending: false,
                  error: failure instanceof Error ? failure.message : "Unable to prepare image",
                }
              : item,
          ),
        );
      }
    }
  };
  return {
    onPaste: (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      if (!files.length || disabled) return;
      const text = event.clipboardData.getData("text/plain");
      // Insert text and labels together at the captured caret before any image
      // decoding finishes. A later keystroke cannot move or overwrite the labels.
      const full = current.current.images.length + files.length > ATTACHMENT_LIMITS.count;
      if (!full || !text) event.preventDefault();
      void add(files, text);
    },
    controls: (
      <>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          aria-label="Choose images"
          onChange={(event) => {
            void add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          className="size-7 shrink-0 justify-center p-0! max-md:size-9"
          aria-label="Attach image"
          disabled={disabled || images.length >= ATTACHMENT_LIMITS.count}
          title="Attach an image, or paste an image directly into the text input"
          onClick={() => input.current?.click()}
        >
          <PaperclipIcon />
        </Button>
      </>
    ),
    notice,
    unfinished: images.some((image) => image.pending || image.error),
  };
}
