import { normalizeRenderedText } from "../shared/rendered-text.ts";
import { installPreviewRuntime } from "../web/src/preview-runtime.ts";
import { createArtifactUtility } from "../web/src/preview-utility.ts";
import type { PreviewScope } from "./preview-contexts.ts";
import type { PreviewSupport } from "./preview-host.ts";

function parameters(scope: PreviewScope): string {
  return JSON.stringify({
    contextId: scope.id,
    applicationOrigin: scope.applicationOrigin,
    artifactId: scope.artifactId,
    versionSeq: scope.versionSeq,
    entryPath: scope.entryPath,
    resourceRoot: `${scope.origin}/files/`,
    presentation: scope.presentation,
  }).replaceAll("<", "\\u003c");
}

export const previewSupport: PreviewSupport = {
  runtime: (scope) =>
    `(${installPreviewRuntime.toString()})(${parameters(scope)}, ${normalizeRenderedText.toString()});`,
  utility: (scope) =>
    `const r3 = (${createArtifactUtility.toString()})(${parameters(scope)}); export { r3 }; export default r3;`,
};
