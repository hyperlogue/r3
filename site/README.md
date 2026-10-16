# r3 public website

The website implementation lives in this folder. It uses Bun and shared HTML
templates, with optional Markdown that permits authored HTML. Custom CSS and
Tailwind utilities share one stylesheet. Ordinary pages ship static HTML and a
small browser script. The homepage shows captures of the real React workspace and links to the selected
interactive example under `/example/index.html`; the existing full demo stays under `/demo/`.

## Build and preview

Run from the repository root with the pinned toolchain available:

```sh
git lfs install
git lfs pull
bun --no-env-file site/build.ts
bun --no-env-file site/serve.ts
```

The Fieldwork PNG captures and social preview PNG use Git LFS. Install Git LFS
before cloning, or run the setup commands above in an existing checkout before
building the site. Builds and capture verification need the image bytes, not
LFS pointer files. CI and Pages download them during checkout. SVG sources
remain ordinary Git files.

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
artifact. The homepage uses an actual workspace capture and a separate demo button opening the same
interactive React page within the artifact; its authored React document needs no
nested preview frame. `R3_SITE_DEMO_URL` defaults to the running local preview's demo URL.
Set it to the deployed demo URL when sharing beyond the local machine.

## Author content

- `catalog.ts` owns page metadata and documentation order.
- `content/` contains articles and the five Example Fieldwork walkthroughs.
- `landing.ts` authors the homepage, use-case index, and search page in HTML.
- `doc-visuals.ts` expands article visual markers into real workspace captures
  and captioned concept diagrams. `doc-style.css` owns their responsive styles.
- `layout.ts` owns the shared shell, documentation navigation, and article layout.
- `theme.ts` reads the palette, font stacks, and overlay tokens directly from
  `web/src/main.css` at build time. `style.css` maps them to site surfaces and
  controls, owns responsive layouts, and scans content for Tailwind utilities.
  Raw HTML in Markdown can use these classes or utilities.
- `client.ts` owns progressive enhancements: theme preference, code/Markdown
  copying, keyboard access to search, and Pagefind results.

The header mark mounts the webapp's shared `Logo` component through `logo.tsx`.
Clicking it plays the same tilted spin, including repeated clicks and reduced
motion support; the separate “r3” text links home. Without JavaScript the mark
stays a static image. The build resolves its SVG beside the site script so it
also works on nested pages and inside an artifact's scoped preview.

Text sections share an 880px maximum width; article prose is limited to 65ch.
The hero uses a wider 1240px container to give its screenshot room. The full
workspace preview stays within 880px. The 1080px feature section pairs five highlights
with playable demo videos in two columns,
followed by concrete use cases. Feature and use-case headings have no number
prefixes; each use-case card starts with a decorative vector UI mockup from
`story-illustrations.ts`. Its category is the main title, followed by a subtitle
and description. The whole card links to its walkthrough; hover and keyboard
focus soften the background, brighten the border, and zoom the illustration to
1.05× inside its frame. Cards stay stationary; reduced motion disables the zoom.
Cards have no arrow icons or footer links. The feature and use-case
sections start directly with their headings. Format details belong in the
documentation.

The homepage centers a copyable publishing-skill command below its opening and
repeats it at the close. A prominent heading and green outline identify the install
step; an outlined copy button changes to a green check after a successful copy. A quiet alternative-installation link sits beneath each command; direct CLI
instructions stay in the getting-started guide. Command highlights preserve the
exact plain text used by the copy action.
Code copying uses a selected-field fallback inside opaque previews and selects
the visible code for manual copying when the browser declines both methods.

The hero shows a cream-and-teal component showcase with large headings
and rounded controls, distinct from r3. Its highlighted button and dot marker
remain visible beside the thread. A real floating thread contains the human’s
request to increase a button margin, the agent’s reply, and a pending draft asking
to restore the previous margin. It has no caption. A stationary Chrome-style
frame surrounds the image, with an active tab, window controls, navigation
icons, and a rounded address bar. The same frame is shared by the full
workspace preview.
Full workspace captures omit the sample banner; the standalone example retains its reset and homepage controls. Captures
are not links; the workspace figure has only a separate demo button beneath its
browser frame. The demo button uses a blue outline. The screenshot, browser
label, and demo destination follow the
selected UI Prototype, Explainer, or Design doc prompt. Both public and packaged pages
use the captures; the selected real workspace opens through the demo button.
The terminal is illustrative, with prompts from `prompt-examples.ts`. The user
message has a lighter background, matching the supplied Claude Code reference.
The inner rows fill the terminal width. The changing task, response, and workspace
screenshot fade together over 420ms; the publishing instruction and sample URL
stay still. It cycles only while visible, supports pause and manual selection,
and stays still with reduced motion or without JavaScript.

Internal authored links start at `/`; the build adds the mount. Headings receive
stable slug IDs with duplicate suffixes. Keep hand-authored HTML IDs unique.
Use repository-relative paths and fictional example data in content.

Docs opens directly into Get started with the shared documentation navigation.
The older `/docs/get-started/` address remains available. Human articles focus on
browser tasks, with short instructions and visual examples. Agent and command
reference URLs point readers to `r3 guide` and `r3 --help`; they are outside the
main sidebar. The short keyboard table uses the product keymap, with the full
map available in the workspace. Product protocol details remain in the built-in
guide and repository reference documentation.
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
`FieldworkDocument` renderer or `PromptDocument` for the search explainer and
project-visibility design proposal. The prototype uses a violet app layout, the
explainer a dark canvas with colored ranking signals, and the proposal a white
document with metadata, access rules, tradeoffs, and rollout notes. The hero
capture selects a separate component fixture and `ComponentsDocument` renderer
through `?scene=components`. No API
aliases, authentication, or server bootstrap are involved. The build rejects runtime imports of connected application modules.

`showcase/fixture.ts` owns the fictional versions and conversation. Comments,
resolution, version selection, comparison, and scripted agent replies use real
product components. Reset restores the fixture and clears sample drafts. One page
per document isolates r3's stylesheet, keyboard bindings, and display preferences.
The launch-campaign walkthrough uses `showcase/media-fixture.ts` with the native
image/video viewer, saved-frame targets, and comparison view. `?scene=media` and
`?scene=media-video` select its image and video conversations. The article shows
three captures in both themes: image feedback, a paused video, and the linked fix.
Its campaign artwork, WebM clips, and decoded frame evidence are checked in; a
normal build does not require a media encoder. To regenerate the source assets:

```sh
R3_TEST_BROWSER=/path/to/chromium R3_TEST_FFMPEG=/path/to/ffmpeg \
  bun --no-env-file site/generate-media-example.ts
R3_TEST_BROWSER=/path/to/chromium bun --no-env-file site/capture-showcase.ts
```

The generated PNG and WebM assets use Git LFS, as do the workspace captures.
The prototype, explainer, and design doc use ordinary React controls. The component
scene runs bundled authored HTML in an opaque iframe with the shared
`installPreviewRuntime`: its blue rectangular highlight, dot marker, picking,
and Locate behavior are actual product code. Its local message adapter connects
only preview UI events to the fixture. No sample runs uploaded content or
emulates the production preview security boundary. The component scene is used
for captures and the standalone website; artifact previews show its PNG because
their policy blocks nested frames.

When the sample's appearance changes, run
`bun --no-env-file site/capture-showcase.ts` with `R3_TEST_BROWSER` set, then build
the site. The capture command builds the same React page independently and records
light/dark desktop, phone, and component-review views at 3× pixel density. The
component capture includes the real r3 navbar above the document and floating thread.
The thread scene locates the agent's fix, opens the runtime's dot marker, and types into its real popover reply
composer without submitting. The two component versions have 8px and 16px button
margins, matching the conversation.
Phone captures close the discussion sheet to show the authored document with the
real mobile navigation and discussion bar. Desktop captures show the document
beside its review conversation.

`assets/fieldwork-captures.json` records the PNG hashes and viewport settings.
A normal build needs no browser and checks image integrity and dimensions.
Screenshot freshness is maintained by visual review; changes to bundled code or
dependencies do not require a refresh. Commit regenerated captures and the
manifest together. They serve no-JavaScript readers and packaged HTML previews;
the demo button opens the same interactive page. The example host bundles
Roboto 3.015 and verifies via Chromium’s actual glyph-font data that the visible
Latest badge uses it before capture. The example stylesheet gives that uppercase
badge additional line height so its lettering has room inside the outline. This avoids
DejaVu fallback metrics on minimal Linux hosts, which placed button text too high.
Other product control layouts stay shared.
Font provenance and license are in `assets/fonts/`.

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
Run `bun --no-env-file site/check-docs.ts` for direct Docs entry, every human
article in both themes at desktop and phone widths, and loaded screenshots.
Run `bun --no-env-file site/check-media.ts` for the launch walkthrough’s responsive
screenshots, saved image/video evidence, comparisons, and actual clip playback.
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
its curve-lab and code-review fixtures. The Example Fieldwork articles include
guided reproduction instructions; the media walkthrough uses actual captures
of its fictional launch campaign.

The five feature rows play silent, 10–18 second MP4 films captured from the real
r3 interface. Native controls support playback, seeking, and fullscreen; nothing
autoplays or downloads video bytes before interaction. Posters and plain-text
transcripts remain available without JavaScript. Transcripts ship with the video
assets; the homepage has no transcript links or caption strips. The recordings use
fictional local fixtures, scripted agent replies, and an authored image reference.
Camera motion, pointer motion, transitions, and titles are editorial overlays.

Final exports live in `assets/videos/`; MP4s and JPEG posters use Git LFS. The
build checks asset hashes and recorded durations against `manifest.json` before
copying them. `transcript.md` records timed titles, actions, and substitutions.
The motion compositor is [motion-anything](https://github.com/nexu-io/motion-anything),
Apache-2.0, pinned to `b016900d9ee92fc2d3e4dc520359cc8999d2ed4e`. It runs only during
production; the website loads native video and no animation engine dependency.
Exports are 1600×1000, 30 fps, H.264/yuv420p with BT.709 color tags and fast-start
metadata. Production sources and captures are kept in a separate video workspace.

The browser and artifact acceptance checks decode all five films, load posters,
seek to three positions, and verify resumed playback. The capability map is in
[COVERAGE.md](COVERAGE.md).
