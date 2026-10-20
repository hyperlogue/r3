import { type RefObject, useEffect, useRef, useState } from "react";
import type { ArtifactDocumentTarget } from "../../../shared/artifacts.ts";
import { ATTACHMENT_LIMITS } from "../../../shared/attachments.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { saveDraftImageOutput } from "../attachment-drafts.ts";
import { useTranslation } from "../i18n.ts";
import { imageMessageBody } from "../image-placeholders.ts";
import { canCapturePreview, capturePreview } from "../screenshot.ts";
import { Button, StrokeIcon } from "../ui.tsx";
import { ImageEditor } from "./ImageEditor.tsx";
import { Notification } from "./Notifications.tsx";

export function PreviewScreenshot({
  artifactId,
  versionSeq,
  path,
  route,
  frame,
  onTarget,
}: {
  artifactId: string;
  versionSeq: number;
  path: string;
  route?: string;
  frame: RefObject<HTMLIFrameElement | null>;
  onTarget: (target: ArtifactDocumentTarget) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    blob: Blob;
    viewport: { width: number; height: number };
  } | null>(null);
  const [notice, setNotice] = useState("");
  const operation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const supported = canCapturePreview();
  useEffect(() => {
    const cancel = () => {
      generation.current++;
      operation.current?.abort();
      operation.current = null;
      setPending(false);
      setSnapshot(null);
    };
    const node = frame.current;
    node?.addEventListener("load", cancel);
    window.addEventListener("pagehide", cancel);
    return () => {
      node?.removeEventListener("load", cancel);
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [frame]);
  const begin = async () => {
    const node = frame.current;
    if (!node) return;
    if ((artifactDrafts.get(artifactId)?.attachments?.length ?? 0) >= ATTACHMENT_LIMITS.count) {
      setNotice(t("previewScreenshot.theDraftAlreadyContainsFourImages"));
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setNotice("");
    const viewport = { width: node.clientWidth, height: node.clientHeight };
    // Hide detached r3 controls that would otherwise occlude the preview pixels.
    document.documentElement.dataset.r3Screenshot = "true";
    const timer = window.setTimeout(() => {
      controller.abort();
      if (operation.current === controller)
        setNotice(t("previewScreenshot.captureTimedOutTryAgainOrPaste"));
    }, 60_000);
    try {
      const blob = await capturePreview(node, controller.signal);
      if (operation.current === controller && !controller.signal.aborted)
        setSnapshot({ blob, viewport });
    } catch (error) {
      if (operation.current === controller && !controller.signal.aborted)
        setNotice(
          error instanceof DOMException
            ? error.name === "NotAllowedError"
              ? t("previewScreenshot.captureCancelledYouCanPasteAScreenshot")
              : t("previewScreenshot.theBrowserCouldNotCaptureThisPreview")
            : error instanceof Error
              ? error.message
              : t("previewScreenshot.unableToCaptureThisPreviewYouCan"),
        );
    } finally {
      clearTimeout(timer);
      delete document.documentElement.dataset.r3Screenshot;
      if (operation.current === controller) {
        operation.current = null;
        setPending(false);
      }
    }
  };
  if (!supported) return null;
  return (
    <>
      <div className="relative">
        <Button
          variant={pending ? "primary-outline" : "nav"}
          className="h-[calc(1.75rem-2px)] w-7 shrink-0 justify-center p-0! max-md:size-9"
          aria-label={
            pending ? t("previewScreenshot.cancelCapture") : t("previewScreenshot.captureArea")
          }
          title={
            pending
              ? t("previewScreenshot.cancelCapture")
              : t("previewScreenshot.captureAreaShareThisTabThenCrop")
          }
          onClick={() => {
            if (pending) {
              operation.current?.abort();
              delete document.documentElement.dataset.r3Screenshot;
              setPending(false);
            } else void begin();
          }}
        >
          <StrokeIcon className="size-4">
            {pending ? (
              <path d="m6 6 12 12M18 6 6 18" />
            ) : (
              <>
                <path d="M8 5 9.5 3h5L16 5h4v14H4V5h4Z" />
                <circle cx="12" cy="12" r="3.5" />
              </>
            )}
          </StrokeIcon>
        </Button>
        {(pending || notice) && (
          <Notification
            title={
              pending
                ? t("previewScreenshot.chooseThisR3Tab")
                : t("previewScreenshot.captureNotice")
            }
            message={pending ? t("previewScreenshot.chooseThisR3TabInTheBrowser") : notice}
            onDismiss={() => {
              if (pending) {
                operation.current?.abort();
                delete document.documentElement.dataset.r3Screenshot;
                setPending(false);
              }
              setNotice("");
            }}
          />
        )}
      </div>
      {snapshot && (
        <ImageEditor
          blob={snapshot.blob}
          onCancel={() => {
            generation.current++;
            setSnapshot(null);
          }}
          onSave={async (output, crop) => {
            const started = generation.current;
            if (
              (artifactDrafts.get(artifactId)?.attachments?.length ?? 0) >= ATTACHMENT_LIMITS.count
            )
              throw new Error(t("previewScreenshot.theDraftAlreadyContainsFourImages"));
            const { attachment, persisted } = await saveDraftImageOutput(artifactId, output, {
              versionSeq,
              path,
              ...(route ? { route } : {}),
              viewport: snapshot.viewport,
              crop,
            });
            if (started !== generation.current)
              throw new Error(t("common.thePreviewChangedCaptureItAgain"));
            if (
              (artifactDrafts.get(artifactId)?.attachments?.length ?? 0) >= ATTACHMENT_LIMITS.count
            )
              throw new Error(t("previewScreenshot.theDraftAlreadyContainsFourImages"));
            onTarget({ kind: "rendered", versionSeq, path, locator: null });
            const draft = artifactDrafts.get(artifactId);
            const before = draft?.attachments ?? [];
            const attachments = [...before, attachment];
            artifactDrafts.update(artifactId, {
              attachments,
              body: imageMessageBody(draft?.body ?? "", before, attachments),
            });
            artifactDrafts.flush();
            setSnapshot(null);
            if (!persisted) setNotice(t("previewScreenshot.screenshotIsAvailableInThisTabBut"));
          }}
        />
      )}
    </>
  );
}
