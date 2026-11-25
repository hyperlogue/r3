import type { ArtifactUtility } from "../../../shared/preview-protocol.ts";

export type RelayedAssets = Pick<ArtifactUtility, "readAsset" | "bindImage" | "bindMedia">;

// Serialized into the preview document: every dependency stays inside this
// function. The preview's own requests are never cached by the browser, so
// published bytes arrive from the workspace as Blobs instead. `prepared` also
// serves the sources that publication deferred in static HTML. A workspace that
// does not relay leaves every read on the preview origin.
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
  const direct = globalThis.fetch;
  const streamURL = (path: string) =>
    root + String(path).split("/").map(encodeURIComponent).join("/");
  // A relaying workspace answers at once. Reads that cannot wait for a late
  // answer use the preview origin; later reads follow the answer when it comes.
  let relays: boolean | undefined;
  const answered = call<boolean>("relaysAssets", null).then(
    (value) => {
      relays = value === true;
    },
    () => {
      relays = false;
    },
  );
  const relaying = () =>
    relays === undefined
      ? Promise.race([
          answered.then(() => relays === true),
          new Promise<boolean>((resolve) => setTimeout(resolve, 1000, false)),
        ])
      : Promise.resolve(relays);
  const streamedBlob = async (path: string) => {
    const file = publishedFile(streamURL(path), root);
    const response = file && (await direct.call(globalThis, file.href));
    if (!response?.ok) throw new Error("Asset is not a published file in this version");
    return response.blob();
  };
  const readMedia = async (path: string, eager: boolean) =>
    (await relaying()) ? call<Blob | null>("readMedia", { path, eager }) : null;
  const pending = new Map<string, Promise<Blob>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  const load = async (path: string) => {
    if (active >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await ((await relaying()) ? call<Blob>("readAsset", path) : streamedBlob(path));
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
  const mediaBindings = new WeakMap<HTMLMediaElement, () => void>();
  const bindMedia = (media: HTMLMediaElement, path: string) => {
    mediaBindings.get(media)?.();
    if (media.hasAttribute("src")) throw new Error("Bind an audio or video element without src");
    const stream = streamURL(path);
    let url: string | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      mediaBindings.delete(media);
      if (media.getAttribute("src") === (url ?? stream)) {
        media.removeAttribute("src");
        media.load();
      }
      if (url) URL.revokeObjectURL(url);
    };
    mediaBindings.set(media, release);
    const play = (blob: Blob | null) => {
      if (released) return;
      if (blob) url = URL.createObjectURL(blob);
      media.src = url ?? stream;
    };
    readMedia(path, media.autoplay || media.preload !== "none").then(play, () => play(null));
    return release;
  };
  const installPreparedSources = () => {
    const selector = "[data-r3-static-src], [data-r3-static-srcset], [data-r3-static-poster]";
    const urls = new Map<string, Promise<string>>();
    async function cachedURL(value: string, base: string) {
      const file = publishedFile(value, base);
      if (!file || !(await relaying())) return value;
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
    function loadMedia(media: HTMLMediaElement) {
      const poster = media.getAttribute("data-r3-static-poster");
      const src = media.getAttribute("data-r3-static-src");
      media.removeAttribute("data-r3-static-poster");
      media.removeAttribute("data-r3-static-src");
      if (poster !== null && !media.hasAttribute("poster"))
        void cachedURL(poster, media.baseURI).then((url) => {
          if (!media.hasAttribute("poster")) media.setAttribute("poster", url);
        });
      if (src === null || media.hasAttribute("src")) return;
      const file = publishedFile(src, media.baseURI);
      // A media fragment selects part of a stream, so that address stays native.
      if (file && !file.fragment) bindMedia(media, file.path);
      else media.src = src;
    }

    // Only a retained candidate becomes a Blob: the browser has not chosen
    // among the sources yet, so nothing is downloaded on its behalf.
    const retained = new Map<string, Promise<string | null>>();
    const retainedURL = (path: string) => {
      let reading = retained.get(path);
      if (!reading) {
        reading = readMedia(path, false).then(
          (blob) => {
            if (!blob) retained.delete(path);
            return blob && URL.createObjectURL(blob);
          },
          () => {
            retained.delete(path);
            return null;
          },
        );
        retained.set(path, reading);
      }
      return reading;
    };
    const pendingSources = new WeakMap<HTMLMediaElement, number>();
    function loadSource(source: HTMLSourceElement) {
      const src = source.getAttribute("data-r3-static-src");
      source.removeAttribute("data-r3-static-src");
      if (src === null || source.hasAttribute("src")) return;
      const media = source.parentElement;
      if (!(media instanceof HTMLMediaElement)) {
        source.src = src;
        return;
      }
      const file = publishedFile(src, source.baseURI);
      const relayed = file && !file.fragment ? file : null;
      pendingSources.set(media, (pendingSources.get(media) ?? 0) + 1);
      void (relayed ? retainedURL(relayed.path) : Promise.resolve(null)).then((url) => {
        if (!source.hasAttribute("src")) source.src = url ?? src;
        // A source that gains its address after insertion is only considered
        // again by a new load, issued once for all of this element's sources.
        const remaining = pendingSources.get(media)! - 1;
        pendingSources.set(media, remaining);
        if (remaining === 0) media.load();
      });
    }

    function visit(node: Node, added: boolean) {
      if (!(node instanceof Element)) return;
      const track = (element: Element) => {
        if (element instanceof HTMLImageElement) {
          if (!added) lazy.unobserve(element);
          else if (element.loading === "lazy") lazy.observe(element);
          else void loadPrepared(element);
        } else if (!added) return;
        else if (element instanceof HTMLMediaElement) loadMedia(element);
        else if (element instanceof HTMLSourceElement) loadSource(element);
      };
      if (node.matches(selector)) track(node);
      if (node.childElementCount) node.querySelectorAll(selector).forEach(track);
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
      const unrelayed = () => direct.call(globalThis, input, init);
      let file: ReturnType<typeof publishedFile>;
      let range: string | null;
      let signal: AbortSignal | null | undefined;
      try {
        const request = input instanceof Request ? input : null;
        if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET") return unrelayed();
        file = publishedFile(request ? request.url : String(input), document.baseURI);
        range = new Headers(init?.headers ?? request?.headers).get("range");
        signal = init?.signal ?? request?.signal;
      } catch {
        return unrelayed();
      }
      if (!file) return unrelayed();
      if (signal?.aborted) return Promise.reject(signal.reason);
      const { path, href } = file;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        relaying()
          .then((relay) =>
            relay
              ? readAsset(path).then((blob) => respond(blob, range, href) ?? unrelayed(), unrelayed)
              : unrelayed(),
          )
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
    }) as typeof fetch;
  };
  if (prepared) {
    installPreparedSources();
    installFetch();
  }
  return { readAsset, bindImage, bindMedia };
}
