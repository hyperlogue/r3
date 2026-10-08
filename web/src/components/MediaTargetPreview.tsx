import { useEffect, useState } from "react";
import type { MediaBox } from "../../../shared/artifacts.ts";
import type { EditableImage } from "./MessageAttachments.tsx";
import { imageBlob } from "./MessageAttachments.tsx";

export function MediaBoxOverlay({ box }: { box: MediaBox }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute border-2 border-primary-500 bg-primary-500/5"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
      }}
    />
  );
}

export function useMediaImage(image?: EditableImage) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let held = "";
    setUrl("");
    setError("");
    if (image)
      void imageBlob(image)
        .then((blob) => {
          if (!alive) return;
          held = URL.createObjectURL(blob);
          setUrl(held);
        })
        .catch((error) => {
          if (alive) setError(error.message);
        });
    const clear = () => {
      alive = false;
      URL.revokeObjectURL(held);
      setUrl("");
    };
    window.addEventListener("r3-images-cleared", clear);
    return () => {
      window.removeEventListener("r3-images-cleared", clear);
      clear();
    };
  }, [image]);
  return { url, error };
}

export function MediaTargetPreview({ image, box }: { image: EditableImage; box: MediaBox }) {
  const { url, error } = useMediaImage(image);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="px-3">
      <div
        className={expanded ? "w-full" : "w-32"}
        style={{ aspectRatio: `${image.width} / ${image.height}` }}
      >
        {url ? (
          <button
            type="button"
            className="relative block w-full"
            title="View saved frame"
            aria-label="View saved frame"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <img
              src={url}
              alt="Saved media target"
              width={image.width}
              height={image.height}
              className="block w-full"
            />
            <MediaBoxOverlay box={box} />
          </button>
        ) : (
          <p role={error ? "alert" : "status"} className="text-xs text-neutral-500">
            {error || "Loading saved frame…"}
          </p>
        )}
      </div>
    </div>
  );
}
