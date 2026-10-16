import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import { normalizeRenderedText } from "../../shared/rendered-text.ts";
import { connectDemoPreview } from "../../web/demo/preview-runtime.ts";
import { installPreviewRuntime } from "../../web/src/preview-runtime.ts";
import { composerKeyAction, observeTextSelection } from "../../web/src/selection-events.ts";
import style from "./component-document.css" with { type: "text" };

declare const COMPONENT_FONT: string;

export function previewHead(config: PreviewBootstrap) {
  const bootstrap = JSON.stringify({ ...config, route: "#" }).replaceAll("<", "\\u003c");
  const runtime = `const config = ${bootstrap};
const connection = (${connectDemoPreview.toString()})(config);
(${installPreviewRuntime.toString()})(config, ${normalizeRenderedText.toString()}, connection, ${observeTextSelection.toString()}, ${composerKeyAction.toString()});`;
  return `<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<style>@font-face{font-family:"r3 Example Sans";src:url(data:font/ttf;base64,${COMPONENT_FONT}) format("truetype");font-weight:100 900;font-display:block}</style>
<script>${runtime.replace(/<\/script/gi, "<\\/script")}</script>`;
}

export function componentDocument(config: PreviewBootstrap) {
  return `<!doctype html><html lang="en"><head>${previewHead(config)}<style>${style}</style></head>
<body><main class="component-document"><div class="component-board">
<p class="component-category">Gather / Components</p><div class="component-card">
<h1>Keep everyone in sync</h1><p>A quick look at what’s happening across your team’s projects.</p>
<button type="button" id="component-action" class="component-action" style="margin-top:${config.versionSeq > 1 ? 16 : 8}px">View activity <span aria-hidden="true">→</span></button>
<p class="component-status" role="status" hidden>You’re all caught up.</p>
</div></div></main><script>document.querySelector('#component-action').onclick=()=>document.querySelector('.component-status').hidden=false;</script></body></html>`;
}
