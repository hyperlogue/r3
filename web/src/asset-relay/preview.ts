import type { ArtifactUtility } from "../../../shared/preview-protocol.ts";

export type RelayedAssets = Pick<ArtifactUtility, "readAsset" | "bindImage">;

// Serialized into the preview document: every dependency stays inside this
// function. The preview's own requests are never cached by the browser, so
// published bytes arrive from the workspace as Blobs instead. `prepared` also
// serves the sources that publication deferred in static HTML.
export function installAssetRelay(
  root: string,
  call: <T>(method: string, input: unknown) => Promise<T>,
  prepared: boolean,
): RelayedAssets {
  const pending = new Map<string, Promise<Blob>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  const load = async (path: string) => {
    if (active >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await call<Blob>("readAsset", path);
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
  const installPreparedImages = () => {
    const selector = "img[data-r3-static-src], img[data-r3-static-srcset]";
    const urls = new Map<string, Promise<string>>();
    const rootPath = new URL(root).pathname;
    async function cachedURL(value: string, base: string) {
      try {
        const url = new URL(value, base);
        if (!value.trim() || !url.href.startsWith(root)) return value;
        const path = decodeURIComponent(url.pathname.slice(rootPath.length));
        let reading = urls.get(path);
        if (!reading) {
          reading = readAsset(path)
            .then((blob) => URL.createObjectURL(blob))
            .catch((error) => {
              urls.delete(path);
              throw error;
            });
          urls.set(path, reading);
        }
        return (await reading) + url.hash;
      } catch {
        return value;
      }
    }

    // In srcset, commas can belong to a URL (including a data URL). Keep the
    // original descriptors and separators, replacing just the URL tokens.
    function cachedSet(value: string, base: string) {
      const parts: (string | Promise<string>)[] = [];
      let last = 0;
      const tokens = /[^\t\n\f\r ,][^\t\n\f\r ]*/g;
      for (let token = tokens.exec(value); token; token = tokens.exec(value)) {
        const url = token[0].replace(/,+$/, "");
        parts.push(value.slice(last, token.index), cachedURL(url, base));
        last = token.index + url.length;
        if (url.length !== token[0].length) continue;
        let parens = false;
        while (tokens.lastIndex < value.length) {
          const ch = value[tokens.lastIndex++];
          if (ch === "," && !parens) break;
          if (ch === "(") parens = true;
          if (ch === ")") parens = false;
        }
      }
      parts.push(value.slice(last));
      return Promise.all(parts).then((pieces) => pieces.join(""));
    }

    async function loadPrepared(image: HTMLImageElement) {
      const src = image.getAttribute("data-r3-static-src");
      const set = image.getAttribute("data-r3-static-srcset");
      image.removeAttribute("data-r3-static-src");
      image.removeAttribute("data-r3-static-srcset");
      if (image.hasAttribute("src") || image.hasAttribute("srcset")) return;
      const [url, candidates] = await Promise.all([
        src === null ? null : cachedURL(src, image.baseURI),
        set === null ? null : cachedSet(set, image.baseURI),
      ]);
      if (image.hasAttribute("src") || image.hasAttribute("srcset")) return;
      if (candidates !== null) image.srcset = candidates;
      if (url !== null) image.src = url;
    }
    const lazy = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazy.unobserve(entry.target);
        void loadPrepared(entry.target as HTMLImageElement);
      }
    });
    function visit(node: Node, added: boolean) {
      if (!(node instanceof Element)) return;
      const track = (image: HTMLImageElement) => {
        if (!added) lazy.unobserve(image);
        else if (image.loading === "lazy") lazy.observe(image);
        else void loadPrepared(image);
      };
      if (node instanceof HTMLImageElement && node.matches(selector)) track(node);
      else if (node.childElementCount)
        node.querySelectorAll<HTMLImageElement>(selector).forEach(track);
    }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) visit(node, false);
        for (const node of record.addedNodes) visit(node, true);
      }
    }).observe(document, { childList: true, subtree: true });
  };
  if (prepared) installPreparedImages();
  return { readAsset, bindImage };
}
