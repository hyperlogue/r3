import { renderPublishedMarkdown, themeStyle } from "./highlight.ts";
import type { DocumentRenderer } from "./publication.ts";

// Bump when changing the persisted document structure or styling. Already
// published versions keep their bytes and revision; reads do not re-render them.
export const DOCUMENT_RENDERER_REVISION = "r3-markdown-3";

const DOCUMENT_CSS = `
:root{color-scheme:light dark;font:16px/1.65 system-ui,sans-serif}
body{margin:0;padding:clamp(20px,5vw,64px);overflow-wrap:anywhere}
main{max-width:900px;margin:auto}
h1,h2,h3,h4{line-height:1.25;margin-top:1.8em}
a{color:light-dark(#245dc5,#86b5ff)}
pre{padding:16px;overflow:auto;border-radius:8px;background:light-dark(#f3f4f6,#181b22)}
code{font:0.9em/1.6 ui-monospace,monospace}
blockquote{margin-inline:0;padding-inline:20px;border-inline-start:3px solid #8888}
img,video,svg{max-width:100%;height:auto}
table{display:block;overflow:auto;border-collapse:collapse}
td,th{padding:8px 12px;border:1px solid #8886;text-align:start}
hr{border:0;border-top:1px solid #8886;margin-block:32px}
.r3-mermaid{margin:0.8em 0;overflow-x:auto;max-width:100%}
.r3-mermaid svg{display:block}
.r3-mmd-node{fill:color-mix(in srgb,currentColor 7%,transparent);stroke:color-mix(in srgb,currentColor 38%,transparent);stroke-width:1.25}
.r3-mmd-node[fill="none"]{fill:none}
.r3-mmd-cluster{fill:color-mix(in srgb,currentColor 4%,transparent);stroke:color-mix(in srgb,currentColor 22%,transparent);stroke-dasharray:5 3;stroke-width:1}
.r3-mmd-edge{fill:none;stroke:color-mix(in srgb,currentColor 50%,transparent);stroke-width:1.25}
.r3-mmd-edge.r3-mmd-dotted{stroke-dasharray:5 4}
.r3-mmd-edge.r3-mmd-thick{stroke-width:2.5}
.r3-mmd-arrow{fill:color-mix(in srgb,currentColor 55%,transparent)}
.r3-mmd-label,.r3-mmd-edgelabel,.r3-mmd-cluster-title{fill:currentColor;font-family:system-ui,sans-serif;font-size:12px;user-select:text}
.r3-mmd-cluster-title{font-weight:600;opacity:0.75}
.r3-mmd-edgelabel{font-size:11px}
.r3-mmd-edgelabel-bg{fill:light-dark(#fff,#0a0a0a)}
.r3-mmd-life{fill:none;stroke:color-mix(in srgb,currentColor 22%,transparent);stroke-width:1;stroke-dasharray:4 3}
`;

export const renderArtifactDocument: DocumentRenderer = Object.assign(
  async (source: string) => {
    const [body, palette] = await Promise.all([renderPublishedMarkdown(source), themeStyle()]);
    const rules = palette.css.split("\n");
    const light = rules
      .filter((rule) => rule.startsWith("html:not(.dark)"))
      .join("\n")
      .replaceAll("html:not(.dark)", "html");
    const dark = rules
      .filter((rule) => rule.startsWith("html.dark"))
      .join("\n")
      .replaceAll("html.dark", "html");
    const syntax = `${light}@media(prefers-color-scheme:dark){${dark}}`;
    return {
      revision: DOCUMENT_RENDERER_REVISION,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${DOCUMENT_CSS}${syntax}</style></head><body><main>${body}</main></body></html>`,
    };
  },
  { revision: DOCUMENT_RENDERER_REVISION },
);
