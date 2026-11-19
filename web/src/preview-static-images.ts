// Serialized into the document bootstrap before the prepared HTML is parsed.
export function installStaticImages(root: string, read: (path: string) => Promise<Blob>): void {
  const selector = "img[data-r3-static-src], img[data-r3-static-srcset]";
  const urls = new Map<string, Promise<string>>();
  const rootPath = new URL(root).pathname;
  async function cachedURL(value: string, base: string) {
    try {
      const url = new URL(value, base);
      if (!value.trim() || !url.href.startsWith(root)) return value;
      const path = decodeURIComponent(url.pathname.slice(rootPath.length));
      let pending = urls.get(path);
      if (!pending) {
        pending = read(path)
          .then((blob) => URL.createObjectURL(blob))
          .catch((error) => {
            urls.delete(path);
            throw error;
          });
        urls.set(path, pending);
      }
      return (await pending) + url.hash;
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

  async function load(image: HTMLImageElement) {
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
      void load(entry.target as HTMLImageElement);
    }
  });
  function visit(node: Node, added: boolean) {
    if (!(node instanceof Element)) return;
    const track = (image: HTMLImageElement) => {
      if (!added) lazy.unobserve(image);
      else if (image.loading === "lazy") lazy.observe(image);
      else void load(image);
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
}
