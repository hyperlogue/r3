import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderer, markdownExport, mountHTML, normalizeBase, publicURL } from "./render.ts";
import { validateLinks } from "./validate.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("deployment URL and mount agree for project Pages and custom domains", () => {
  expect(normalizeBase("/r3//")).toBe("/r3");
  expect(normalizeBase("/")).toBe("");
  expect(publicURL("/r3", "https://example.test/r3/")).toBe("https://example.test/r3");
  expect(publicURL("", "https://example.test")).toBe("https://example.test");
  expect(() => normalizeBase("https://example.test")).toThrow();
  expect(() => publicURL("/r3", "https://example.test/")).toThrow();
  expect(() => publicURL("", "https://example.test/?tracking=yes")).toThrow();
});

test("mounting rewrites authored HTML resources and exports while preserving code and outside links", async () => {
  const html = await mountHTML(
    '<a href="/docs/">Docs</a><img src="/image.svg"><button data-markdown="/docs/index.md">Copy</button><a href="#target">Jump</a><a href="https://example.test/">Outside</a><code>&lt;img src="/image.svg"&gt;</code>',
    "/r3",
  );
  expect(html).toContain('href="/r3/docs/"');
  expect(html).toContain('src="/r3/image.svg"');
  expect(html).toContain('data-markdown="/r3/docs/index.md"');
  expect(html).toContain('href="#target"');
  expect(html).toContain('href="https://example.test/"');
  expect(html).toContain('&lt;img src="/image.svg"&gt;');
});

test("authored HTML and utility classes survive Markdown, and duplicate headings remain linkable", async () => {
  const renderer = await createRenderer();
  try {
    const result = renderer.render(
      '## Read this\n\n<div class="grid gap-4">A custom layout</div>\n\n## Read this\n\n```html\n<script>example()</script>\n```',
    );
    expect(result.headings.map((heading) => heading.id)).toEqual(["read-this", "read-this-2"]);
    expect(result.html).toContain('<div class="grid gap-4">A custom layout</div>');
    expect(result.html).not.toContain("<script>example()</script>");
    expect(result.html).toContain("shiki");
  } finally {
    renderer.dispose();
  }
});

test("agent exports preserve code examples and turn site links into complete URLs", () => {
  const result = markdownExport(
    'Read [the guide](/docs/agents/).\n\n```html\n<div>Keep this example</div>\n```\n\n<div class="scenario"><strong>Review</strong><p>Visible explanation.</p></div>',
    "https://example.test/r3",
  );
  expect(result).toContain("[the guide](https://example.test/r3/docs/agents/)");
  expect(result).toContain("<div>Keep this example</div>");
  expect(result).not.toContain('class="scenario"');
  expect(result).toContain("Visible explanation.");
});

test("link validation rejects missing assets and anchors instead of shipping broken navigation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r3-site-links-"));
  temporary.push(dir);
  await Bun.write(join(dir, "index.html"), "home");
  await Bun.write(join(dir, "docs/index.html"), "docs");
  await validateLinks(
    dir,
    new Map([
      ["index.html", '<a href="/r3/docs/#read">Read</a>'],
      ["docs/index.html", '<h1 id="read">Read</h1>'],
    ]),
    "/r3",
  );
  await expect(
    validateLinks(dir, new Map([["index.html", '<img src="/r3/missing.svg">']]), "/r3"),
  ).rejects.toThrow("Missing link");
  await expect(
    validateLinks(
      dir,
      new Map([
        ["index.html", '<a href="/r3/docs/#missing">Read</a>'],
        ["docs/index.html", '<h1 id="read">Read</h1>'],
      ]),
      "/r3",
    ),
  ).rejects.toThrow("Missing anchor");
  await expect(
    validateLinks(dir, new Map([["index.html", '<a href="/docs/">Read</a>']]), "/r3"),
  ).rejects.toThrow("escapes mount");
});
