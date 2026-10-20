import { ATTACHMENT_LIMITS } from "../../shared/attachments.ts";
import { t } from "./i18n.ts";

type CroppableTrack = MediaStreamTrack & { cropTo(target: unknown): Promise<void> };
type CropWindow = Window & {
  CropTarget?: { fromElement(element: Element): Promise<unknown> };
  ImageCapture?: new (track: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> };
};
let requesting = false;

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function canCapturePreview(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof (window as CropWindow).CropTarget?.fromElement === "function" &&
    !!(window as CropWindow).ImageCapture
  );
}

// The trusted workspace owns every track. No frame, port, or publisher utility
// ever receives the stream or its uncropped pixels.
export async function capturePreview(element: HTMLElement, signal: AbortSignal): Promise<Blob> {
  if (!canCapturePreview())
    throw new Error(t("Area capture is unavailable here. Paste or attach a screenshot instead."));
  if (requesting) throw new Error(t("Finish the existing browser sharing prompt first"));
  requesting = true;
  let stream: MediaStream | undefined;
  let frame: ImageBitmap | undefined;
  let chooserPending = false;
  const stop = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  signal.addEventListener("abort", stop);
  const check = () => {
    signal.throwIfAborted();
    if (!element.isConnected) throw new Error(t("The preview changed. Capture it again."));
  };
  try {
    check();
    // Invoke synchronously from the button's gesture, before deriving a target.
    const request = navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
      preferCurrentTab: true,
      surfaceSwitching: "exclude",
    } as DisplayMediaStreamOptions);
    chooserPending = true;
    const chosen = request.then(
      (result) => {
        chooserPending = false;
        // Native prompts cannot be dismissed programmatically. A late grant must
        // be stopped even after the cancelled caller has already returned.
        if (signal.aborted) {
          for (const track of result.getTracks()) track.stop();
          requesting = false;
        }
        return result;
      },
      (error) => {
        chooserPending = false;
        requesting = false;
        throw error;
      },
    );
    stream = await untilAborted(chosen, signal);
    check();
    const track = stream.getVideoTracks()[0] as CroppableTrack | undefined;
    if (track?.getSettings().displaySurface !== "browser" || typeof track.cropTo !== "function")
      throw new Error(t("Select this r3 browser tab to capture the preview"));
    const target = await untilAborted(
      (window as CropWindow).CropTarget!.fromElement(element),
      signal,
    );
    check();
    await untilAborted(track.cropTo(target), signal);
    check();
    // Read one frame directly from the cropped track. Detached video playback
    // can suspend after viewport changes and is unnecessary for a still image.
    const capture = new (window as CropWindow).ImageCapture!(track);
    for (let attempt = 0; ; attempt++) {
      try {
        const captured = capture.grabFrame().then((image) => {
          if (signal.aborted) {
            image.close();
            throw signal.reason;
          }
          return image;
        });
        frame = await untilAborted(captured, signal);
        break;
      } catch (error) {
        check();
        // Chromium can reject the first frame while a resized/cropped capture
        // source is starting. Retry transient frame acquisition on this stream;
        // never reopen the chooser or reuse a frame from before cropping.
        if (
          attempt >= 2 ||
          track.readyState !== "live" ||
          (error !== undefined &&
            (!(error instanceof DOMException) || error.name !== "UnknownError"))
        )
          throw error;
        await untilAborted(
          new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
          signal,
        );
      }
    }
    check();
    stop();
    if (!frame.width || !frame.height)
      throw new Error(t("The browser did not provide a screenshot frame"));
    if (frame.width * frame.height > ATTACHMENT_LIMITS.pixels)
      throw new Error(t("Preview exceeds 20 megapixels. Reduce the window size and try again."));
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d")!.drawImage(frame, 0, 0);
    const blob = await untilAborted(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error(t("Unable to capture this preview"))),
          "image/png",
        ),
      ),
      signal,
    );
    check();
    return blob;
  } finally {
    stop();
    frame?.close();
    signal.removeEventListener("abort", stop);
    if (!chooserPending) requesting = false;
  }
}
