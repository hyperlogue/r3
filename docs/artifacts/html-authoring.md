# Authoring HTML artifacts

Use `r3 guide html` for publication commands, directory preparation, stable element
IDs, and named reply fix links. This guide covers the page runtime and device API.
The [security model](../../.claude/skills/security-model/SKILL.md#preview-host)
owns isolation and enforcement details.

## Pages and assets

Publish scripts, ES modules, styles, images, media, and data alongside the root
`index.html`. Markdown may be linked as companion content; use a files artifact
for a collection of Markdown documents. Use relative URLs, hash routes, or published document
paths. The preview supplies the selected version's resource root. Automatic
root-relative URL rewriting, history-route fallback, dependency installation,
and backend hosting are outside this feature.

Keep large images in standalone files and reuse their paths:

```html
<img src="./assets/hero.webp" alt="Hero illustration">
```

Extract large embedded base64/data-URL images before publication. Publish the
complete directory on every version so the entrypoint and its dependencies stay
together. The HTML workspace has no file browser; expose supporting pages and
assets through the entrypoint's content or navigation.

## Page utility

Pages can import `/r3/utility.js` to use the
[ArtifactUtility interface](../../shared/preview-protocol.ts):

- `getContext()` returns this artifact, version, document path, and resource root.
- `getThreads()` reads this artifact's conversations.
- `createFeedback({ body, locator })`, `reply({ feedbackId, body })`, and `submit()`
  use the same threads and explicit handoff as the feedback panel. Human mutations
  require user activation.
- `subscribe(callback)` observes changes and returns an unsubscribe function.
- `getTheme()` and `setTheme(theme)` read and save a `"light"` or `"dark"` preference
  for this artifact and r3 site. Writes require a user gesture. This is optional:
  authored HTML controls its appearance, and arbitrary page state is not persisted.
  Rendered Markdown follows r3's application theme.
- `getUserMedia(constraints)` requests device capture with the permissions below.

The utility exposes no application credential, general API access, publication,
lifecycle, or host execution capability. Theme preferences never save network
exceptions or device grants.

## Network and device permissions

Bundle dependencies locally: external requests are blocked by default. Browsers
without verified network enforcement can offer compatibility rendering after a
risk acknowledgment; isolation and application authentication remain enforced.
Compatibility mode can leave outbound channels open despite restrictive headers.

HTML artifacts offer **Allow external access** with confirmation. This permits
external resources and APIs subject to browser CORS. Enable it only for trusted
content: external scripts can send published files, conversations, user input,
and shared device data elsewhere. Restoring protection cannot undo prior disclosure.

The confirmation also offers optional **Camera** and **Microphone** checkboxes,
initially off. Browser permission is independently required. HTTPS and localhost
support capture. Device permission applies to the current document; external
access applies to the selected version visit. Neither grant is persisted.
**Stop sharing** stops physical capture and clears device consent. Navigation,
version changes, leaving the preview, and restoring protection also end capture.

In external mode, the runtime adapts `navigator.mediaDevices.getUserMedia` so an
existing page can request devices while keeping its opaque origin:

```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 640 }, facingMode: "user" },
  audio: true,
});
video.srcObject = stream;
// Stop this page's tracks when done; r3 also provides Stop sharing.
stream.getTracks().forEach((track) => track.stop());
```

The trusted parent captures devices and relays a real `MediaStream` over WebRTC.
One capture can run at a time. Video supports width, height, frame rate, aspect
ratio, and facing mode; audio supports echo cancellation, noise suppression,
automatic gain, sample rate, and channel count. Unsupported constraints are
rejected. Device enumeration, device IDs, screen capture, and camera pan/tilt/zoom
are unavailable.

Returned tracks are WebRTC receiver tracks: their settings and subsequent
`applyConstraints()` do not control the physical device. Normal playback and
recording work. Track `stop()`/`clone()` and stream `clone()` keep source lifetimes
coordinated; bypassing those methods or cloning a separately constructed stream
is outside this adapter's contract. r3's Stop sharing always stops physical
devices independently of the page's track bookkeeping.
