import { expect, test } from "bun:test";
import { pageSource } from "./build.ts";
import { docs } from "./catalog.ts";
import { localePath } from "./i18n.ts";
import english from "./locales/en.json";
import chinese from "./locales/zh-cn.json";
import { localizeHTML } from "./localize.ts";
import { createRenderer, mountHTML } from "./render.ts";

test("localized paths preserve shared assets, external links and existing locale prefixes", () => {
  expect(localePath("/docs/#install", "zh-cn")).toBe("/zh-cn/docs/#install");
  expect(localePath("/zh-cn/docs/index.md", "zh-cn")).toBe("/zh-cn/docs/index.md");
  expect(localePath("/assets/site.js", "zh-cn")).toBe("/assets/site.js");
  expect(localePath("/demo/", "zh-cn")).toBe("/demo/");
  expect(localePath("//example.test/", "zh-cn")).toBe("//example.test/");
});

test("static localization escapes translations and leaves authored code and Markdown prose alone", async () => {
  const catalog = chinese as Record<string, string>;
  const previous = catalog.Search;
  catalog.Search = "<Search & translated>";
  try {
    const html = await mountHTML(
      await localizeHTML(
        '<html lang="en"><head><script>const example = "Search";</script></head><body><a href="/docs/#read" title="Search">Search</a><code>Search &amp; code</code><div class="prose"><p>Search</p><div data-visual-i18n><span>Search</span></div><p>Search</p></div><a data-locale="en" href="/docs/">English</a><img src="/assets/sample.png" alt="Search"></body></html>',
        "zh-cn",
      ),
      "/r3",
    );
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('href="/r3/zh-cn/docs/#read"');
    expect(html).toContain('data-locale="en" href="/r3/docs/"');
    expect(html).toContain('src="/r3/assets/sample.png"');
    expect(html).toContain("&lt;Search &amp; translated&gt;");
    expect(html).not.toContain("><Search & translated>");
    expect(html).toContain('<script>const example = "Search";</script>');
    expect(html).toContain("<code>Search &amp; code</code>");
    expect(html.match(/<p>Search<\/p>/g)).toHaveLength(2);
  } finally {
    if (previous === undefined) delete catalog.Search;
    else catalog.Search = previous;
  }
});

test("translated headings retain their English link destinations", async () => {
  const renderer = await createRenderer();
  try {
    const original = renderer.render(
      "## Install the skill\n\n### Other methods\n\n## Install the skill",
    );
    const translated = renderer.render("## 安装\n\n### 其他方法\n\n## 安装", original.headingIds);
    expect(translated.html).toContain('id="install-the-skill"');
    expect(translated.html).toContain('id="other-methods"');
    expect(translated.html).toContain('id="install-the-skill-2"');
    expect(translated.headings[0].text).toBe("安装");
  } finally {
    renderer.dispose();
  }
});

test("site translation catalogs and article placeholders are complete", async () => {
  expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  for (const [key, value] of Object.entries(chinese)) {
    const parameters = (text: string) => [...new Set(text.match(/\{\w+\}/g))].sort();
    expect(parameters(value || key)).toEqual(parameters(key));
  }
  for (const page of docs) {
    const path = `./locales/zh-cn/${page.source ? "content" : "reference"}/${page.source ?? page.guide}.md`;
    expect(await Bun.file(new URL(path, import.meta.url)).exists(), page.path).toBe(true);
    expect((await pageSource(page, "zh-cn")).trim()).not.toBe("");
  }
});
