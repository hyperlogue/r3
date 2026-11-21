import type { Hono } from "hono";
import { resourceResponse } from "./artifact-resources.ts";
import { ArtifactError } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";

// Chromium keeps no HTTP cache for subresources requested by the preview's
// opaque sandbox origin. The workspace therefore downloads published bytes by
// digest, retains them itself, and hands them to the preview. The server half of
// that workaround lives in this file and the browser half in
// web/src/asset-relay/; a preview origin the browser caches for retires both.
export function installAssetRelay(app: Hono, artifacts: ArtifactStore): void {
  app.get("/api/blobs/:hash", (c) => {
    const hash = c.req.param("hash");
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ArtifactError("Invalid content digest");
    return resourceResponse(c.req.raw, () => artifacts.publishedBlob(hash), { filename: hash });
  });
}

// Hide authored sources from the preload scanner until the workspace can supply
// retained bytes. Moving the attribute keeps its entities for the HTML parser.
// Only document-relative addresses can name a published file.
export function deferStaticSources(rewriter: HTMLRewriter): HTMLRewriter {
  const relative = (value: string | null) =>
    !!value?.trim() && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value.trim());
  const defer = (element: HTMLRewriterTypes.Element, names: string[]) => {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      element.setAttribute(`data-r3-static-${name}`, value);
      element.removeAttribute(name);
    }
  };
  return rewriter
    .on("img", {
      element(image) {
        if (image.getAttribute("srcset") || relative(image.getAttribute("src")))
          defer(image, ["src", "srcset"]);
      },
    })
    .on("video, audio", {
      element(media) {
        for (const name of ["src", "poster"])
          if (relative(media.getAttribute(name))) defer(media, [name]);
      },
    })
    .on("video > source, audio > source", {
      element(source) {
        if (relative(source.getAttribute("src"))) defer(source, ["src"]);
      },
    });
}
