import assert from "node:assert/strict";
import { renderArtifactDocument } from "../server/artifact-document.ts";

const playwright = await import(process.env.R3_TEST_PLAYWRIGHT!);
const engine = process.env.R3_TEST_ENGINE ?? "chromium";
const build = await Bun.build({
  entrypoints: ["web/src/passive-markdown.ts"],
  target: "browser",
  minify: true,
});
if (!build.success) throw new Error("Passive Markdown acceptance module failed to build");
let unwantedRequests = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/sink/")) unwantedRequests++;
    if (path === "/reader.js")
      return new Response(build.outputs[0], { headers: { "content-type": "text/javascript" } });
    return new Response("<!doctype html><title>Passive reading acceptance</title>", {
      headers: {
        "content-type": "text/html",
        "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
      },
    });
  },
});
const browser = await playwright[engine].launch({
  headless: true,
  executablePath: process.env.R3_TEST_BROWSER,
  ...(engine === "chromium" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`http://localhost:${app.port}`);
  await page.evaluate(async () => {
    const moduleUrl = "/reader.js";
    const { passiveMarkdownDocument } = await import(moduleUrl);
    const sink = `${location.origin}/sink/`;
    const html = `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=${sink}refresh">
      <base href="${sink}base"><link rel="stylesheet" href="${sink}style">
      <style>@import url('${sink}import');body{margin:0;font:18px sans-serif;background-image:url('${sink}background')}@font-face{font-family:trap;src:url('${sink}font')}main{font-family:trap,sans-serif}a::before{content:url('${sink}content')}@media(prefers-color-scheme:dark){.code{color:rgb(123,234,123)}}</style>
      </head><body onload="fetch('${sink}body')"><main><h1>Readable Markdown</h1>
      <a href="${sink}navigate" ping="${sink}ping">Disabled link</a>
      <a href="javascript:fetch('${sink}javascript')">Script link</a>
      <img src="${sink}image" srcset="${sink}srcset 2x" alt="Image description" onerror="fetch('${sink}error')">
      <form action="${sink}form"><input autofocus onfocus="fetch('${sink}focus')"><button>Submit</button></form>
      <iframe src="${sink}frame"></iframe><object data="${sink}object"></object>
      <script>fetch('${sink}script')</script><script src="${sink}external"></script>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><defs><marker id="arrow"><path d="M0 0L5 5"/></marker></defs><path d="M0 0L20 20" marker-end="url(#arrow)"/><a href="${sink}svg"><text x="0" y="20">Diagram text</text></a><image href="${sink}svg-image"/><foreignObject><iframe src="${sink}foreign"></iframe></foreignObject><animate attributeName="href" values="${sink}animate"/></svg>
      <pre><code class="code">const value = 42;</code></pre>${"<p>A readable paragraph.</p>".repeat(80)}</main></body></html>`;
    const nonce = crypto.randomUUID();
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.style.cssText = "width:100%;height:500px;border:0";
    frame.title = "Passive Markdown";
    const messages: any[] = [];
    Object.assign(window, { passiveMessages: messages });
    window.addEventListener("message", (event) => {
      if (
        event.source === frame.contentWindow &&
        event.origin === "null" &&
        event.data?.nonce === nonce
      )
        messages.push(event.data);
    });
    frame.srcdoc = passiveMarkdownDocument(html, {
      nonce,
      applicationOrigin: location.origin,
      theme: "dark",
      fitContent: false,
      position: { x: 0, y: 200 },
    });
    document.body.append(frame);
  });
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "Readable Markdown" }).waitFor();
  await page.waitForFunction(() =>
    (window as any).passiveMessages.some((message: any) => message.height > 1000),
  );
  const state = await frame.locator("body").evaluate(() => {
    let parentDenied = false;
    try {
      void parent.document;
    } catch {
      parentDenied = true;
    }
    return {
      origin: globalThis.origin,
      parentDenied,
      color: getComputedStyle(document.body).color,
      code: getComputedStyle(document.querySelector("code")!).color,
      scroll: scrollY,
      scripts: document.scripts.length,
      unsafe: document.querySelectorAll(
        "[href],[src],[srcset],[ping],[onerror],[onload],form,iframe,object,input,foreignObject,animate",
      ).length,
    };
  });
  assert.equal(state.origin, "null");
  assert.equal(state.parentDenied, true);
  assert.equal(state.color, "rgb(245, 245, 245)");
  assert.equal(state.code, "rgb(123, 234, 123)");
  assert.equal(state.scroll, 200);
  assert.equal(state.scripts, 1, "only the trusted measurement/scroll helper executes");
  assert.equal(state.unsafe, 0, "publisher navigation, resource, and active elements are removed");
  await frame.getByText("Disabled link", { exact: true }).click();
  await frame.getByText("Script link", { exact: true }).click();
  await frame.getByText("Diagram text", { exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(
    unwantedRequests,
    0,
    "neither inert parsing nor the passive reader may send publisher requests",
  );
  assert.equal(page.frames().filter((frame: any) => frame !== page.mainFrame()).length, 1);
  const rendered = await renderArtifactDocument(
    '# Diagram\n\n```mermaid\nflowchart LR\nsubgraph 世界 ["两座城市"]\nA["<b>起点</b><br>输入"] <==>|"道路"| B[终点]\nend\n```\n',
    "index.md",
  );
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
    await page.evaluate(
      async ({ html, theme }: { html: string; theme: "light" | "dark" }) => {
        const moduleUrl = "/reader.js";
        const { passiveMarkdownDocument } = await import(moduleUrl);
        const iframe = document.querySelector("iframe")!;
        await new Promise<void>((resolve) => {
          iframe.onload = () => resolve();
          iframe.srcdoc = passiveMarkdownDocument(html, {
            nonce: crypto.randomUUID(),
            applicationOrigin: location.origin,
            theme,
            fitContent: false,
          });
        });
      },
      { html: rendered.html, theme },
    );
    await frame.getByRole("heading", { name: "Diagram", exact: true }).waitFor();
    const diagram = await frame.locator("svg").evaluate((svg: SVGElement) => {
      const style = (selector: string) => getComputedStyle(svg.querySelector(selector)!);
      return {
        label: style(".r3-mmd-label").fill,
        node: style(".r3-mmd-node").fill,
        edge: style(".r3-mmd-edge").stroke,
        arrow: style(".r3-mmd-arrow").fill,
        title: svg.querySelector(".r3-mmd-cluster-title")!.textContent,
        marker: style(".r3-mmd-edge").markerStart,
      };
    });
    assert.equal(diagram.label, theme === "dark" ? "rgb(245, 245, 245)" : "rgb(23, 23, 23)");
    assert.notEqual(diagram.node, diagram.label, "Passive diagram labels contrast with nodes");
    assert.notEqual(diagram.edge, "none", "Passive diagrams keep their connections");
    assert.notEqual(diagram.arrow, "rgb(0, 0, 0)", "Passive diagrams keep themed arrows");
    assert.notEqual(diagram.marker, "none", "Passive diagrams retain both arrow endpoints");
    assert.equal(diagram.title, "两座城市");
  }
  assert.equal(unwantedRequests, 0, "Mermaid styles and markers need no external resources");
  console.log(
    `${engine}: passive Markdown preserves formatting/theme/scroll and readable Mermaid diagrams with no publisher requests, navigation, script execution or parent access`,
  );
} finally {
  await browser.close();
  app.stop(true);
}
