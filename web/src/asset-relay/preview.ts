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
  const rootPath = new URL(root).pathname;
  // A URL inside this version's published files; null for every other address.
  const publishedFile = (value: string, base: string) => {
    try {
      const url = new URL(value, base);
      if (!value.trim() || !url.href.startsWith(root)) return null;
      const path = decodeURIComponent(url.pathname.slice(rootPath.length));
      return { path, fragment: url.hash, href: url.href };
    } catch {
      return null;
    }
  };
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
    async function cachedURL(value: string, base: string) {
      const file = publishedFile(value, base);
      if (!file) return value;
      try {
        let reading = urls.get(file.path);
        if (!reading) {
          reading = readAsset(file.path)
            .then((blob) => URL.createObjectURL(blob))
            .catch((error) => {
              urls.delete(file.path);
              throw error;
            });
          urls.set(file.path, reading);
        }
        return (await reading) + file.fragment;
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
  // Publisher code keeps calling fetch(); GET requests for published files are
  // answered from relayed bytes. Anything the relay cannot answer exactly, such
  // as a missing file or an unsatisfiable range, goes to the server unchanged.
  const installFetch = () => {
    const native = globalThis.fetch;
    const respond = (blob: Blob, range: string | null, href: string) => {
      const headers = new Headers({
        "content-type": blob.type || "application/octet-stream",
        "accept-ranges": "bytes",
      });
      let body = blob;
      if (range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match || (!match[1] && !match[2])) return null;
        const start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
        const end =
          match[1] && match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
        if (!(start <= end) || (!match[1] && Number(match[2]) === 0)) return null;
        body = blob.slice(start, end + 1, blob.type);
        headers.set("content-range", `bytes ${start}-${end}/${blob.size}`);
      }
      headers.set("content-length", String(body.size));
      const response = new Response(body, { status: range === null ? 200 : 206, headers });
      Object.defineProperty(response, "url", { value: href });
      return response;
    };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const direct = () => native.call(globalThis, input, init);
      let file: ReturnType<typeof publishedFile>;
      let range: string | null;
      let signal: AbortSignal | null | undefined;
      try {
        const request = input instanceof Request ? input : null;
        if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET") return direct();
        file = publishedFile(request ? request.url : String(input), document.baseURI);
        range = new Headers(init?.headers ?? request?.headers).get("range");
        signal = init?.signal ?? request?.signal;
      } catch {
        return direct();
      }
      if (!file) return direct();
      if (signal?.aborted) return Promise.reject(signal.reason);
      const { path, href } = file;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        readAsset(path)
          .then((blob) => respond(blob, range, href) ?? direct(), direct)
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
    }) as typeof fetch;
  };
  if (prepared) {
    installPreparedImages();
    installFetch();
  }
  return { readAsset, bindImage };
}
