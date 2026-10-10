# r3 public website

The website implementation lives in this folder. It uses Bun and shared HTML
templates, with optional Markdown that permits authored HTML. Custom CSS and
Tailwind utilities share one stylesheet. Ordinary pages ship static HTML and a
small browser script. The homepage embeds the real React workspace under
`/example/index.html`; the existing full demo stays under `/demo/`.

## Build and preview

Run from the repository root with the pinned toolchain available:

```sh
git lfs install
git lfs pull
bun --no-env-file site/build.ts
bun --no-env-file site/serve.ts
```

The Fieldwork PNG captures use Git LFS. Install Git LFS before cloning, or run
the setup commands above in an existing checkout before building the site.
The capture verifier needs the image bytes, not LFS pointer files. CI and Pages
download them during checkout. The small social image and SVG sources remain
ordinary Git files.

The preview server binds to loopback and defaults to port 4173. Override it with
`R3_SITE_PORT`. Rebuild after changing content; the preview serves `dist/pages/`.

To exercise a GitHub project mount:

```sh
R3_SITE_BASE=/r3 R3_SITE_URL=https://example.test/r3 bun --no-env-file site/build.ts
R3_SITE_BASE=/r3 bun --no-env-file site/serve.ts
```

Use an empty `R3_SITE_BASE` for a root/custom-domain deployment. `R3_SITE_URL`
must include the same mount path. The Pages workflow supplies both values from
the configured repository site. Without a public URL, local builds use
`example.test` for metadata.

The builder cleans `dist/pages/`, writes pages and text exports, compiles assets,
builds the existing demo, indexes only the authored website pages with Pagefind,
and validates internal destinations and anchors. A root 404 page restores demo
deep links while retaining a useful missing-page experience elsewhere.

To publish the built text and layouts as an r3 HTML artifact, run
`bun --no-env-file site/package-artifact.ts`, then publish `dist/site-artifact/`.
Use the same `R3_SITE_BASE` as the preceding build. Packaging uses relative asset
URLs and explicit document filenames, with no dependency on server directory
redirects. Search runs without a worker in the opaque preview. The live demo
opens separately because its own nested previews are unavailable inside an r3
artifact. The homepage uses an actual workspace capture linking to the same
interactive React page within the artifact; its authored React document needs no
nested preview frame. `R3_SITE_DEMO_URL` defaults to the running local preview's demo URL.
Set it to the deployed demo URL when sharing beyond the local machine.

## Author content

- `catalog.ts` owns page metadata and documentation order.
- `content/` contains articles and the five Example Fieldwork walkthroughs.
- `landing.ts` authors the homepage and directory pages directly in HTML.
- `layout.ts` owns the shared shell, documentation navigation, and article layout.
- `theme.ts` reads the palette, font stacks, and overlay tokens directly from
  `web/src/main.css` at build time. `style.css` maps them to site surfaces and
  controls, owns responsive layouts, and scans content for Tailwind utilities.
  Raw HTML in Markdown can use these classes or utilities.
- `client.ts` owns progressive enhancements: theme preference, code/Markdown
  copying, keyboard access to search, and Pagefind results.

Internal authored links start at `/`; the build adds the mount. Headings receive
stable slug IDs with duplicate suffixes. Keep hand-authored HTML IDs unique.
Use repository-relative paths and fictional example data in content.

The CLI reference and agent guides are generated from `cli/artifact-help.ts`.
The keyboard reference is generated from the product keymap. Edit the source
that owns behavior when changing product instructions; this site consumes it.
Each article has `index.md`, and the build writes `llms.txt` and `llms-full.txt`.
Markdown exports preserve fenced code and turn internal links into public URLs.
The exporter converts the simple HTML prose layouts used here; give a new custom
interactive layout an equivalent readable explanation.

`assets/social.svg` is the editable link-preview artwork. After changing it, run
`bun --no-env-file site/render-social.ts` with `R3_TEST_BROWSER` set to regenerate
the PNG used by link-preview services. Browser tooling is not needed for a normal
site build.

## Authentic workspace example

`showcase/index.tsx` mounts `ArtifactPage` from `web/src/artifact-page.tsx`, exactly
as the connected r3 app does. It supplies a detail snapshot, reads, mutation
handlers from the existing in-memory demo backend, and the authored
`FieldworkDocument` renderer. No API aliases, authentication, or server bootstrap
are involved. The build rejects runtime imports of connected application modules.

`showcase/fixture.ts` owns the fictional versions and conversation. Comments,
resolution, version selection, comparison, and scripted agent replies use real
product components. Reset restores the fixture and clears sample drafts. One page
per document isolates r3's stylesheet, keyboard bindings, and display preferences.
The sample renderer uses ordinary React controls; it does not run uploaded HTML
or emulate the production preview security boundary.

After changing the sample or shared UI, run
`bun --no-env-file site/capture-showcase.ts` with `R3_TEST_BROWSER` set, then build
the site. The capture command builds the same React page independently and records
light/dark desktop and phone views at 3× pixel density. Phone readers see the real
mobile layout; the desktop capture covers the site's maximum content width.

`assets/fieldwork-captures.json` binds those PNGs and viewport settings to a hash
of the actual bundled JavaScript, CSS, and document. A normal build needs no
browser, but fails if the captures are missing, modified, or stale after any
bundled UI, fixture, style, or dependency change. Commit regenerated captures and
the manifest together. They serve no-JavaScript readers and packaged HTML
previews; the normal website embeds the same interactive page. System fonts use
the product's own stack, so their precise appearance still follows the platform.

## Dependencies

All dependencies come from the root manifest: Bun, TypeScript, markdown-it,
Shiki, Tailwind with bun-plugin-tailwind, and Pagefind. The workspace reuses the
app’s React, React DOM, TanStack Query, and existing UI dependencies. Shiki and Markdown parsing
run at build time. Pagefind indexes static output and searches locally in the
browser. The site loads no remote fonts, analytics, or hosted search service.

## Verify

```sh
bun --no-env-file test site/site.test.ts
bun --no-env-file run typecheck
biome check .
```

After a build, set `R3_TEST_BROWSER` to an installed Chromium executable and run
`bun --no-env-file site/check-browser.ts` with the same `R3_SITE_BASE`. It uses a
fresh profile and an ephemeral loopback static server. It checks desktop/mobile
layout, theme persistence, clipboard actions, search and empty results, no-JS
reading, and demo deep links. Screenshots go to ignored `dist/site-review/`.
Run `bun --no-env-file site/check-showcase.ts` to exercise injected mutations,
comparison, mobile layout, and the absence of backend requests. Run the
repository-wide tests before committing.

After packaging, `bun --no-env-file site/check-artifact.ts` serves only the bundle
through the real preview policy in an isolated browser. It checks relative
navigation, theme, search, screenshot density at desktop/phone widths, and React
interactions inside the opaque sandbox.

## Content boundary

The homepage uses the actual r3 page with a fictional Example Fieldwork project;
the captions identify the sample data and scripted agent. The full demo retains
its curve-lab and code-review fixtures. The five Example Fieldwork articles are
guided reproduction instructions, not five scripted demo scenarios.

Video production remains follow-up work. There are no empty video players or
claims that those recordings already exist. The capability map is in
[COVERAGE.md](COVERAGE.md).
