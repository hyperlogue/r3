import { normalizeRenderedText } from "../shared/rendered-text.ts";
import { previewIceComplete } from "../web/src/preview-capture.ts";
import { connectPreview } from "../web/src/preview-channel.ts";
import { installMarkdownTheme } from "../web/src/preview-markdown.ts";
import { createPreviewMedia } from "../web/src/preview-media.ts";
import { installPreviewRuntime } from "../web/src/preview-runtime.ts";
import { createArtifactUtility } from "../web/src/preview-utility.ts";
import { type PreviewScope, previewRoot } from "./preview-contexts.ts";
import type { PreviewSupport } from "./preview-host.ts";

function parameters(scope: PreviewScope): string {
  return JSON.stringify({
    contextId: scope.id,
    applicationOrigin: scope.applicationOrigin,
    artifactId: scope.artifactId,
    versionSeq: scope.versionSeq,
    entryPath: scope.entryPath,
    resourceRoot: `${previewRoot(scope)}/files/`,
    presentation: scope.presentation,
    capture: scope.network === "external",
  }).replaceAll("<", "\\u003c");
}

export const previewSupport: PreviewSupport = {
  runtime: (scope) =>
    `(() => { const config = ${parameters(scope)};
const connection = (${connectPreview.toString()})(config);
(${installMarkdownTheme.toString()})(config, connection);
const getUserMedia = (${createPreviewMedia.toString()})(config, connection, ${previewIceComplete.toString()});
Object.defineProperty(globalThis, "__r3ArtifactUtility", {value: (${createArtifactUtility.toString()})(config, connection, getUserMedia)});
(${installPreviewRuntime.toString()})(config, ${normalizeRenderedText.toString()}, connection); })();`,
  utility: () => "const r3 = globalThis.__r3ArtifactUtility; export { r3 }; export default r3;",
};
