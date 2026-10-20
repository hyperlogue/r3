import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import * as pagefind from "pagefind";
import { buildDemo } from "../scripts/build-demo.ts";
import { t as appText } from "../web/src/i18n.ts";
import { KEYMAP } from "../web/src/keys.ts";
import { cases, getCatalog, homeTitle, type Page, pages } from "./catalog.ts";
import { expandDocVisuals } from "./doc-visuals.ts";
import { verifyFeatureVideos } from "./feature-videos.ts";
import { features } from "./features.ts";
import { h, type Locale, localePath, locales, siteTranslator } from "./i18n.ts";
import { home, searchPage, useCases } from "./landing.ts";
import { shell } from "./layout.ts";
import { localizeHTML } from "./localize.ts";
import { commonPrompt, promptExamples } from "./prompt-examples.ts";
import {
  createRenderer,
  escapeHTML,
  markdownExport,
  mountHTML,
  normalizeBase,
  publicURL,
} from "./render.ts";
import { richText } from "./rich-text.tsx";
import { buildShowcase } from "./showcase/build.ts";
import { captureSpecs, verifyCaptures } from "./showcase/captures.ts";
import { frontendTheme } from "./theme.ts";
import { validateLinks } from "./validate.ts";

export const siteDirectory = import.meta.dir;
export const outputDirectory = join(siteDirectory, "../dist/pages");

export async function pageSource(page: Page, locale: Locale = "en") {
  if (locale !== "en" && (page.source || page.guide)) {
    const translated = Bun.file(
      join(
        siteDirectory,
        "locales",
        locale,
        page.source ? "content" : "reference",
        `${page.source ?? page.guide}.md`,
      ),
    );
    if (await translated.exists()) return translated.text();
  }
  if (page.source) return Bun.file(join(siteDirectory, "content", `${page.source}.md`)).text();
  if (page.guide === "keys") {
    const useful = new Set(["help", "commentModeToggle", "handOff", "filePicker", "panelToggle"]);
    return `Press **?** in the workspace for the full keyboard map. These are a few useful starting points.

| Key | Action |
| --- | --- |
${KEYMAP.filter((key) => useful.has(key.id))
  .map(
    (key) =>
      `| ${key.keys.map((chord) => `\`${chord === "S" ? "Shift + S" : chord}\``).join(" or ")} | ${appText(key.label, { lng: "en" })} |`,
  )
  .join("\n")}

Shortcuts pause while you type or use an overlay. Every action also has a visible control.
`;
  }
  if (page.guide) {
    const command =
      page.guide === "cli"
        ? "r3 --help"
        : `r3 guide${page.guide === "main" ? "" : ` ${page.guide}`}`;
    return `## Use the built-in reference

Ask your agent to run:

\`\`\`sh
${command}
\`\`\`

The installed CLI provides the current commands and publication rules. Your agent handles capture, publishing, and feedback delivery.

For your part of the workflow, start with [Get started](/docs/) or [Precise feedback](/docs/feedback/).
`;
  }
  return "";
}

export function landingMarkdown(page: Page) {
  if (page.path === "/use-cases/")
    return `# Example Fieldwork\n\n${page.description}\n\n${cases.map((p) => `- [${p.title}](${p.path}): ${p.description}`).join("\n")}\n\nThe separate [live demo](/demo/) uses a curve lab and a code review with scripted agent replies.\n`;
  return `# r3 — ${homeTitle}\n\n${page.description}\n\nLocal by default. [Connect to your own server](/docs/access/) to keep artifacts on a remote backend while agents run on your machine.\n\n## Features\n\n${features.map((feature) => `### ${feature.title}\n\n${feature.description}\n\n[Watch the ${feature.duration}-second demo](/assets/videos/${feature.id}.mp4) · [Read transcript](/assets/videos/${feature.id}.transcript.txt)`).join("\n\n")}\n\nThe homepage pairs these five features with silent, playable demos of the real r3 interface. Each lasts 10–18 seconds and has a text transcript. The recordings use fictional local data and scripted agent replies.\n\n## Start a review\n\nInstall the publishing skill with \`npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global\`, choose your coding agents, then ask an agent to publish its work to r3. No global r3 installation is required.\n\n## Then ask your agent\n\nThe homepage illustrates these prompts in a terminal. The shared publishing instruction stays in place while examples fade. Choose a prompt or pause the animation.\n\n${promptExamples.map((example) => `- **${example.label}:** ${example.prompt} ${commonPrompt}`).join("\n")}\n\n[Install the skill](/docs/get-started/#install-the-skill) · [Other installation methods](/docs/get-started/#other-installation-methods) · [Try the live demo](/demo/) · [Use cases](/use-cases/) · [Documentation](/docs/)\n\nThe homepage’s [Example Fieldwork workspace](/example/index.html) uses the real r3 React page with fictional data and scripted agent replies.\n`;
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
  const exports: { page: Page; text: string; locale: Locale }[] = [];
  try {
    for (const locale of locales) {
      const { pages: localizedPages, landingPages } = getCatalog(locale);
      for (const page of localizedPages) {
        const isArticle = !landingPages.includes(page);
        const landingSource = Bun.file(
          join(
            siteDirectory,
            "locales",
            locale,
            "content",
            page.path === "/" ? "home.md" : "use-cases.md",
          ),
        );
        const source = isArticle
          ? await pageSource(page, locale)
          : locale !== "en" && (await landingSource.exists())
            ? await landingSource.text()
            : landingMarkdown(page);
        const illustrated = expandDocVisuals(source, locale);
        const original =
          locale === "en"
            ? undefined
            : renderer.render(
                expandDocVisuals(isArticle ? await pageSource(page) : landingMarkdown(page)),
              );
        const rendered = renderer.render(illustrated, original?.headingIds);
        const landing: Record<string, (locale: Locale) => string> = {
          "/": home,
          "/use-cases/": useCases,
          "/search/": searchPage,
        };
        const html = await mountHTML(
          await localizeHTML(
            shell(page, isArticle ? rendered.html : landing[page.path](locale), {
              base,
              origin,
              locale,
              headings: rendered.headings,
              article: isArticle,
              markdown: page.path !== "/search/",
            }),
            locale,
          ),
          base,
        );
        const file = `${localePath(page.path, locale).slice(1)}index.html`;
        await Bun.write(join(outputDirectory, file), html);
        htmlPages.set(file, html);
        if (page.path !== "/search/") {
          const text = markdownExport(
            (isArticle
              ? `# ${page.title}\n\n${page.description}\n\n${illustrated}`
              : source
            ).replace(
              /\]\((\/(?!\/)[^)]*)\)/g,
              (_, path: string) => `](${localePath(path, locale)})`,
            ),
            origin,
          );
          await Bun.write(
            join(outputDirectory, localePath(page.path, locale).slice(1), "index.md"),
            `${text}\n`,
          );
          if (!page.canonicalPath) exports.push({ page, text, locale });
        }
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
    plugins: [
      tailwind,
      {
        name: "site-logo-asset",
        setup(build) {
          // The shared Logo fetches its SVG. Resolve it from the script so
          // nested pages and scoped artifact URLs use the same favicon bytes.
          build.onLoad({ filter: /[\\/]web[\\/]favicon\.svg$/ }, () => ({
            loader: "js",
            contents: 'export default new URL("./favicon.svg", import.meta.url).href;',
          }));
        },
      },
    ],
    naming: "[name].[ext]",
  });
  if (!assets.success) throw new AggregateError(assets.logs, "Site assets failed to build");
  await cp(join(outputDirectory, "assets/client.js"), join(outputDirectory, "assets/site.js"));
  await cp(join(outputDirectory, "assets/style.css"), join(outputDirectory, "assets/site.css"));
  await rm(join(outputDirectory, "assets/client.js"));
  await rm(join(outputDirectory, "assets/style.css"));
  await cp(join(siteDirectory, "../web/favicon.svg"), join(outputDirectory, "assets/favicon.svg"));
  await cp(join(siteDirectory, "assets/social.png"), join(outputDirectory, "assets/social.png"));

  await verifyFeatureVideos(join(siteDirectory, "assets/videos"));
  await cp(join(siteDirectory, "assets/videos"), join(outputDirectory, "assets/videos"), {
    recursive: true,
  });

  await buildShowcase(join(outputDirectory, "example"));
  await verifyCaptures(join(siteDirectory, "assets"));
  for (const { file } of captureSpecs) {
    await cp(join(siteDirectory, "assets", file), join(outputDirectory, "assets", file));
  }

  // The standalone demo keeps its own fixtures; the five website walkthroughs
  // have their interactive scenes in the site-owned showcase above.
  await buildDemo({ directory: join(outputDirectory, "demo"), base: `${base}/demo/` });
  const demoPath = `${base}/demo/`;
  const restoreRoute = `<script>try{const p=new URLSearchParams(location.search).get('r3-route');if(p&&p.startsWith(${JSON.stringify(demoPath)})){const u=new URL(p,location.origin);if(u.origin===location.origin)history.replaceState(null,'',u.pathname+u.search+u.hash)}}catch{}</script>`;
  const demoIndex = (await Bun.file(join(outputDirectory, "demo/index.html")).text())
    .replace("<head>", `<head>${restoreRoute}`)
    .replace(/<title>.*?<\/title>/, "<title>r3 — Demo</title>");
  await Bun.write(join(outputDirectory, "demo/index.html"), demoIndex);
  await rm(join(outputDirectory, "demo/404.html"));

  const fallback = `<script>if(location.pathname.startsWith(${JSON.stringify(demoPath)}))location.replace(${JSON.stringify(demoPath)}+'?r3-route='+encodeURIComponent(location.pathname+location.search+location.hash))</script>`;
  for (const locale of locales) {
    const t = siteTranslator(locale);
    const missing: Page = {
      path: "/404.html",
      title: t("common.thisPageIsnTHere"),
      description: t("common.findYourWayBackToTheR3"),
      group: "",
    };
    const missingHTML = await mountHTML(
      await localizeHTML(
        shell(
          missing,
          `<section class="index-hero container"><p class="eyebrow">${h("common.404NotFound", locale)}</p><h1>${h("common.thisPageIsnTHere2", locale)}</h1><p class="lede">${h("common.theAddressMayHaveChangedFindA", locale)}</p><div class="actions"><a class="button primary" href="/docs/">${h("common.browseDocumentation", locale)}</a><a class="text-link" href="/">${h("common.backToR3", locale)}</a></div><noscript><p>${richText("common.pOpeningADemoDeepLinkRequires", locale, { demo: "/demo/" })}</p></noscript></section>${fallback}`,
          { base, origin, locale, markdown: false },
        ),
        locale,
      ),
      base,
    );
    await Bun.write(
      join(outputDirectory, localePath("/404.html", locale).slice(1)),
      missingHTML.replace(
        '<meta name="description"',
        '<meta name="robots" content="noindex"><meta name="description"',
      ),
    );
    htmlPages.set(localePath("/404.html", locale).slice(1), missingHTML);
  }

  for (const locale of locales) {
    const localizedExports = exports.filter((item) => item.locale === locale);
    const indexText = `# r3\n\n> ${homeTitle} A local-first workspace for published artifacts and human/agent conversations.\n\nCurrent documentation. The built-in \`r3 guide\` is the agent workflow source. All example IDs and Example Fieldwork scenarios are illustrative.\n\n## Start here\n\n- [Get started](${origin}${localePath("/docs/get-started/index.md", locale)})\n- [Agent workflow](${origin}${localePath("/docs/agents/index.md", locale)})\n- [Complete documentation text](${origin}${localePath("/llms-full.txt", locale)})\n\n## Pages\n\n${localizedExports.map(({ page }) => `- [${page.title}](${origin}${localePath(page.path, locale)}index.md): ${page.description}`).join("\n")}\n`;
    await Bun.write(join(outputDirectory, localePath("/llms.txt", locale).slice(1)), indexText);
    await Bun.write(
      join(outputDirectory, localePath("/llms-full.txt", locale).slice(1)),
      localizedExports
        .map(({ page, text }) => `Source: ${origin}${localePath(page.path, locale)}\n\n${text}`)
        .join("\n\n---\n\n"),
    );
  }
  await Bun.write(
    join(outputDirectory, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages
      .filter((page) => page.path !== "/search/" && !page.canonicalPath)
      .flatMap((page) =>
        locales.map(
          (locale) => `<url><loc>${escapeHTML(origin + localePath(page.path, locale))}</loc></url>`,
        ),
      )
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
    for (const locale of locales) {
      for (const page of pages.filter((p) => p.path !== "/search/" && !p.canonicalPath)) {
        const result = await created.index.addHTMLFile({
          url: localePath(page.path, locale),
          content: htmlPages.get(`${localePath(page.path, locale).slice(1)}index.html`)!,
        });
        if (result.errors.length) throw new Error(result.errors.join(", "));
      }
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
    `Built ${pages.length * locales.length} pages, ${exports.length} Markdown exports, search, and demo → dist/pages`,
  );
}

if (import.meta.main) await buildSite();
