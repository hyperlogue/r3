import type { ArtifactUtility } from "../../shared/preview-protocol.ts";

// Serialized into the preview alongside the utility.
export function createPreviewAssets(
  read: (path: string) => Promise<Blob>,
): Pick<ArtifactUtility, "readAsset" | "bindImage"> {
  const pending = new Map<string, Promise<Blob>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  const load = async (path: string) => {
    if (active >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await read(path);
    } finally {
      pending.delete(path);
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  const readAsset = (path: string) => {
    const existing = pending.get(path);
    if (existing) return existing;
    const result = load(path);
    pending.set(path, result);
    return result;
  };

  const bindings = new WeakMap<HTMLImageElement, { load(): void; release(): void }>();
  let observer: IntersectionObserver | undefined;
  const bindImage = (image: HTMLImageElement, path: string) => {
    bindings.get(image)?.release();
    if (image.hasAttribute("src") || image.hasAttribute("srcset") || image.closest("picture"))
      throw new Error("Bind a plain img without src or srcset");
    let url: string | undefined;
    let released = false;
    let started = false;
    const release = () => {
      if (released) return;
      released = true;
      observer?.unobserve(image);
      bindings.delete(image);
      if (url) {
        if (image.getAttribute("src") === url) image.removeAttribute("src");
        URL.revokeObjectURL(url);
      }
    };
    const loadImage = () => {
      if (started || released) return;
      started = true;
      observer?.unobserve(image);
      void readAsset(path).then(
        (blob) => {
          if (released) return;
          url = URL.createObjectURL(blob);
          image.src = url;
        },
        () => {
          if (!released) image.dispatchEvent(new Event("error"));
        },
      );
    };
    bindings.set(image, { load: loadImage, release });
    if (
      image.loading === "eager" ||
      image.fetchPriority === "high" ||
      typeof IntersectionObserver === "undefined"
    )
      loadImage();
    else {
      observer ??= new IntersectionObserver((entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) bindings.get(entry.target as HTMLImageElement)?.load();
      });
      observer.observe(image);
    }
    return release;
  };
  return { readAsset, bindImage };
}
