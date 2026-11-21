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
