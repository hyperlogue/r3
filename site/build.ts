import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import * as pagefind from "pagefind";
import { ARTIFACT_HELP, artifactGuide } from "../cli/artifact-help.ts";
import { buildDemo } from "../scripts/build-demo.ts";
import { KEYMAP } from "../web/src/keys.ts";
import { cases, docs, landingPages, type Page, pages } from "./catalog.ts";
import { docsIndex, home, searchPage, useCases } from "./landing.ts";
import { shell } from "./layout.ts";
import {
  createRenderer,
  escapeHTML,
  markdownExport,
  mountHTML,
  normalizeBase,
  publicURL,
} from "./render.ts";
import { buildShowcase } from "./showcase/build.ts";
import { captureSpecs, showcaseHash, verifyCaptures } from "./showcase/captures.ts";
import { frontendTheme } from "./theme.ts";
import { validateLinks } from "./validate.ts";

export const siteDirectory = import.meta.dir;
export const outputDirectory = join(siteDirectory, "../dist/pages");

export async function pageSource(page: Page) {
  if (page.source) return Bun.file(join(siteDirectory, "content", `${page.source}.md`)).text();
  if (page.guide === "cli")
    return [
      "This reference is generated from `r3 --help`. Agents should read the [agent workflow](/docs/agents/) before publishing or handling feedback.",
      "## Commands and options",
      "```text",
      ARTIFACT_HELP.trim(),
      "```",
      "",
    ].join("\n\n");
  if (page.guide === "keys")
    return `Open the keyboard-shortcuts control in the workspace, or press \`?\`. These bindings come directly from the product’s keyboard map. Shifted characters such as \`S\` and \`Z\` require Shift.\n\nShortcuts stand down in text fields and overlays. Some commands are only available in the relevant view. Hidden feedback controls do not keep their actions active.\n\n${[
      ...new Set(KEYMAP.map((key) => key.group)),
    ]
      .map(
        (group) =>
          `## ${group}\n\n| Key | Action |\n| --- | --- |\n${KEYMAP.filter(
            (key) => key.group === group,
          )
            .map(
              (key) => `| ${key.keys.map((chord) => `\`${chord}\``).join(" or ")} | ${key.label} |`,
            )
            .join("\n")}`,
      )
      .join(
        "\n\n",
      )}\n\nUse the visible controls when a browser reserves a keyboard shortcut. The [navigation guide](/docs/navigation/) covers panels, file browsing, and mobile review.\n`;
  if (page.guide)
    return `This page is generated from \`r3 guide${page.guide === "main" ? "" : ` ${page.guide}`}\` in the current source.\n\n${artifactGuide(page.guide === "main" ? [] : [page.guide]).replace(/^# .+\n+/, "")}`;
  return "";
}

function landingMarkdown(page: Page) {
  if (page.path === "/docs/")
    return `# Documentation\n\n${page.description}\n\n${docs.map((p) => `- [${p.title}](${p.path}): ${p.description}`).join("\n")}\n`;
  if (page.path === "/use-cases/")
    return `# Example Fieldwork\n\n${page.description}\n\n${cases.map((p) => `- [${p.title}](${p.path}): ${p.description}`).join("\n")}\n\nThe separate [live demo](/demo/) uses a curve lab and a code review with scripted agent replies.\n`;
  return `# r3 — Render. Review. Refine.\n\nSee the work. Point to the change. Make it better.\n\n${page.description}\n\n## A clearer review loop\n\n1. Ask your agent to publish an interactive page, document, file collection, or code diff.\n2. Select the element, passage, line, or media region you want to discuss. Send precise feedback.\n3. Follow the agent’s reply to a new publication and its verified fix. You decide when to resolve the thread.\n\n## Start a review\n\nInstall with \`npm install -g @hyperlogue/r3\`. Ask your agent to read \`r3 guide\` and publish its work.\n\n[Get started](/docs/get-started/) · [Try the live demo](/demo/) · [Use cases](/use-cases/) · [Documentation](/docs/)\n\nThe homepage’s [Example Fieldwork workspace](/example/index.html) uses the real r3 React page with fictional data and scripted agent replies.\n`;
}

export async function buildSite() {
  const base = normalizeBase(process.env.R3_SITE_BASE);
  const origin = publicURL(base, process.env.R3_SITE_URL);
  if (!process.env.R3_SITE_URL)
    console.log("Using example.test for preview metadata; set R3_SITE_URL for deployment.");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(outputDirectory, "assets"), { recursive: true });
  await Bun.write(join(outputDirectory, "assets/r3-theme.css"), await frontendTheme());
  const renderer = await createRenderer();
  const htmlPages = new Map<string, string>();
  const exports: { page: Page; text: string }[] = [];
  try {
    for (const page of pages) {
      const isArticle = !landingPages.includes(page);
      const source = isArticle ? await pageSource(page) : landingMarkdown(page);
      const rendered = renderer.render(source);
      const landing: Record<string, () => string> = {
        "/": home,
        "/docs/": docsIndex,
        "/use-cases/": useCases,
        "/search/": searchPage,
      };
      const html = await mountHTML(
        shell(page, isArticle ? rendered.html : landing[page.path](), {
          base,
          origin,
          headings: rendered.headings,
          article: isArticle,
          markdown: page.path !== "/search/",
        }),
        base,
      );
      const file = `${page.path.slice(1)}index.html`;
      await Bun.write(join(outputDirectory, file), html);
      htmlPages.set(file, html);
      if (page.path !== "/search/") {
        const text = markdownExport(
          isArticle ? `# ${page.title}\n\n${page.description}\n\n${source}` : source,
          origin,
        );
        await Bun.write(join(outputDirectory, page.path.slice(1), "index.md"), `${text}\n`);
        exports.push({ page, text });
      }
    }
  } finally {
    renderer.dispose();
  }

  const assets = await Bun.build({
    entrypoints: [join(siteDirectory, "client.ts"), join(siteDirectory, "style.css")],
    outdir: join(outputDirectory, "assets"),
    target: "browser",
    minify: true,
    plugins: [tailwind],
    naming: "[name].[ext]",
  });
  if (!assets.success) throw new AggregateError(assets.logs, "Site assets failed to build");
  await cp(join(outputDirectory, "assets/client.js"), join(outputDirectory, "assets/site.js"));
  await cp(join(outputDirectory, "assets/style.css"), join(outputDirectory, "assets/site.css"));
  await rm(join(outputDirectory, "assets/client.js"));
  await rm(join(outputDirectory, "assets/style.css"));
  await cp(join(siteDirectory, "../web/favicon.svg"), join(outputDirectory, "assets/favicon.svg"));
  await cp(join(siteDirectory, "assets/social.png"), join(outputDirectory, "assets/social.png"));

  await buildShowcase(join(outputDirectory, "example"));
  await verifyCaptures(
    await showcaseHash(join(outputDirectory, "example")),
    join(siteDirectory, "assets"),
  );
  for (const { file } of captureSpecs) {
    await cp(join(siteDirectory, "assets", file), join(outputDirectory, "assets", file));
  }

  // Reuse the current real demo. This content/layout pass does not replace its
  // fixtures or promise that the five editorial walkthroughs are demo scenarios.
  await buildDemo({ directory: join(outputDirectory, "demo"), base: `${base}/demo/` });
  const demoPath = `${base}/demo/`;
  const restoreRoute = `<script>try{const p=new URLSearchParams(location.search).get('r3-route');if(p&&p.startsWith(${JSON.stringify(demoPath)})){const u=new URL(p,location.origin);if(u.origin===location.origin)history.replaceState(null,'',u.pathname+u.search+u.hash)}}catch{}</script>`;
  const demoIndex = (await Bun.file(join(outputDirectory, "demo/index.html")).text()).replace(
    "<head>",
    `<head>${restoreRoute}`,
  );
  await Bun.write(join(outputDirectory, "demo/index.html"), demoIndex);
  await rm(join(outputDirectory, "demo/404.html"));

  const missing: Page = {
    path: "/404.html",
    title: "This page isn’t here",
    description: "Find your way back to the r3 docs or live demo.",
    group: "Not found",
  };
  const fallback = `<script>if(location.pathname.startsWith(${JSON.stringify(demoPath)}))location.replace(${JSON.stringify(demoPath)}+'?r3-route='+encodeURIComponent(location.pathname+location.search+location.hash))</script>`;
  const missingHTML = await mountHTML(
    shell(
      missing,
      `<section class="index-hero container"><p class="eyebrow">404 / Not found</p><h1>This page isn’t here.</h1><p class="lede">The address may have changed. Find a workflow in the docs, or return to the homepage.</p><div class="actions"><a class="button primary" href="/docs/">Browse documentation →</a><a class="text-link" href="/">Back to r3</a></div><noscript><p>Opening a demo deep link requires JavaScript. <a href="/demo/">Open the demo start page</a>.</p></noscript></section>${fallback}`,
      { base, origin, markdown: false },
    ),
    base,
  );
  await Bun.write(
    join(outputDirectory, "404.html"),
    missingHTML.replace(
      '<meta name="description"',
      '<meta name="robots" content="noindex"><meta name="description"',
    ),
  );
  htmlPages.set("404.html", missingHTML);

  const indexText = `# r3\n\n> Render. Review. Refine. A local-first workspace for published artifacts and human/agent conversations.\n\nCurrent documentation. The built-in \`r3 guide\` is the agent workflow source. All example IDs and Example Fieldwork scenarios are illustrative.\n\n## Start here\n\n- [Get started](${origin}/docs/get-started/index.md)\n- [Agent workflow](${origin}/docs/agents/index.md)\n- [Complete documentation text](${origin}/llms-full.txt)\n\n## Pages\n\n${exports.map(({ page }) => `- [${page.title}](${origin}${page.path}index.md): ${page.description}`).join("\n")}\n`;
  await Bun.write(join(outputDirectory, "llms.txt"), indexText);
  await Bun.write(
    join(outputDirectory, "llms-full.txt"),
    exports.map(({ page, text }) => `Source: ${origin}${page.path}\n\n${text}`).join("\n\n---\n\n"),
  );
  await Bun.write(
    join(outputDirectory, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages
      .filter((page) => page.path !== "/search/")
      .map((page) => `<url><loc>${escapeHTML(origin + page.path)}</loc></url>`)
      .join("")}</urlset>`,
  );
  await Bun.write(
    join(outputDirectory, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  );

  const created = await pagefind.createIndex();
  if (!created.index || created.errors.length)
    throw new Error(`Pagefind: ${created.errors.join(", ")}`);
  try {
    for (const page of pages.filter((p) => p.path !== "/search/")) {
      const result = await created.index.addHTMLFile({
        url: page.path,
        content: htmlPages.get(`${page.path.slice(1)}index.html`)!,
      });
      if (result.errors.length) throw new Error(result.errors.join(", "));
    }
    const result = await created.index.writeFiles({
      outputPath: join(outputDirectory, "pagefind"),
    });
    if (result.errors.length) throw new Error(result.errors.join(", "));
  } finally {
    await pagefind.close();
  }
  await validateLinks(outputDirectory, htmlPages, base);
  console.log(
    `Built ${pages.length} pages, ${exports.length} Markdown exports, search, and demo → dist/pages`,
  );
}

if (import.meta.main) await buildSite();
