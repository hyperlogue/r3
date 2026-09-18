import { normalizeRenderedText } from "../shared/rendered-text.ts";
import { previewIceComplete } from "../web/src/preview-capture.ts";
import { connectPreview } from "../web/src/preview-channel.ts";
import { installMarkdownLayout, installMarkdownTheme } from "../web/src/preview-markdown.ts";
import { installMarkdownDocument } from "../web/src/preview-markdown-document.ts";
import { createPreviewMedia } from "../web/src/preview-media.ts";
import { installPreviewRuntime } from "../web/src/preview-runtime.ts";
import { installPreviewScroll } from "../web/src/preview-scroll.ts";
import { createArtifactUtility } from "../web/src/preview-utility.ts";
import { restoreReadingPosition } from "../web/src/restore-reading-position.ts";
import { composerKeyAction, observeTextSelection } from "../web/src/selection-events.ts";
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
const markdown = document.currentScript?.hasAttribute("data-r3-markdown") === true;
const shell = document.currentScript?.hasAttribute("data-r3-markdown-shell") === true;
const connection = (${connectPreview.toString()})(config);
const install = () => {
(${installPreviewScroll.toString()})(config, connection, ${restoreReadingPosition.toString()});
(${installMarkdownTheme.toString()})(config, connection, markdown);
(${installMarkdownLayout.toString()})(config, connection, markdown);
const getUserMedia = (${createPreviewMedia.toString()})(config, connection, ${previewIceComplete.toString()});
Object.defineProperty(globalThis, "__r3ArtifactUtility", {value: (${createArtifactUtility.toString()})(config, connection, getUserMedia)});
(${installPreviewRuntime.toString()})(config, ${normalizeRenderedText.toString()}, connection, ${observeTextSelection.toString()}, ${composerKeyAction.toString()}); };
if (shell) (${installMarkdownDocument.toString()})(config, connection, install); else install(); })();`,
  utility: () => "const r3 = globalThis.__r3ArtifactUtility; export { r3 }; export default r3;",
};
