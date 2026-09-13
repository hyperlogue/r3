---
name: mobile-tier
description: r3's phone-tier (below Tailwind md/768px) design — the isolate-don't-interleave rule, web/src/mobile/ containers, the bottom bar + 3-state feedback sheet, sticky toolbar/--pane-sticky-h mechanics, touch selection anchoring via AddFeedbackPill and usePointerCoarse, and the compact-target/16px-font ergonomics. Use when changing anything that renders below md, touching web/src/mobile/, adding max-md:/pointer-coarse: classes, working on touch selection or the mobile sheet, or debugging a phone/tablet layout.
---

# The phone tier

This file is the **design source of truth** for r3 below Tailwind `md` — update it
here when the mobile design changes.

The phone tier supports reading, version switching, feedback, replies, resolution,
and Submit below `md` (768px). Artifact authoring stays with the publisher.
Portrait tablets keep the desktop layout.

## The prime rule: isolate, don't interleave

Mobile must not add complexity to desktop code.

- All mobile UI lives in **`web/src/mobile/`**, and **desktop components never
  import from it**.
- Existing components get only **inert `max-md:` / `pointer-coarse:` class
  tweaks**. The one exception is `JumpToFile`'s inline
  `matchMedia("(pointer: coarse)")` probe, which suppresses autofocus on touch — it
  can't import `usePointerCoarse` without breaking the isolation rule.
- The **single mount point** is `ArtifactView`, which swaps the side dock for
  `MobileReviewChrome`. Panel and domain state never fork, and the same
  `ArtifactThreads` renders with the same props either way.

`web/src/mobile/` holds containers **only**: `useIsMobile` + `usePointerCoarse`
(both over `useMediaQuery`), `MobileReviewChrome` (bottom bar + the 3-state
feedback sheet), and `AddFeedbackPill` (the touch selection-anchor pill).

**Side-by-side diffs never render below `md`.** Two code columns don't fit a phone
pane, so `ArtifactView` forces `layout="unified"` and the workspace toolbar hides the toggle
(`max-md:hidden`, an inert class — desktop components still don't import from
`mobile/`). The override deliberately does **not** write the persisted preference,
so a split-preferring reader gets split back on a wide viewport.

## Layout

The file sidebar hides; HTML artifacts have no sidebar at any width. The shared
workspace toolbar retains its file controls below `md`. The version selector moves
from the top navigation into the three-dot details popover, where its choices
expand inline and selecting one closes the popover. An older selected version has
an **Open latest** button in that version section; it also closes the popover when
selected. The artifact
title and actions occupy the shared top navigation, outside the scrolling pane;
the content toolbar sticks. The title truncates to preserve space for compact
controls, with metadata and the selected version's description in the details popover.
`--pane-sticky-h` records its measured height so file headers and Locate geometry
use the same offset. The pane stays the one source/diff scroll container.

Large diff artifacts progressively hydrate file bodies through
`web/src/progressive.tsx`. Stable measured shells preserve sticky headers, the
scroll spy, file picking, and Locate geometry. Files artifacts use the same complete
stack, with per-file source/rendered controls and source row virtualization. Scale behavior is shared,
not a mobile fork. Rendered documents scroll in their isolated preview frame.

A persistent bottom bar (`Feedback · N open` — the whole bar is the toggle; watcher
presence shows only inside the panel) toggles a bottom **sheet** hosting the panel,
with three discrete tap-only states:

1. **closed**
2. **composer peek** — a short sheet: the composer over the still-visible code,
   raised by any anchor gesture
3. **full**

Locate/ref jumps close the sheet before scrolling the code pane.

## Navigation

The shared `JumpToFile` picker is a toolbar button for files/diff on **both** tiers: a flat
filterable list with viewed ticks, filter input pinned at the bottom, Enter jumps
to the top match. Popover on desktop, sheet below `md`.

## Anchoring (touch)

Keyed on the **pointer, not the width tier** (`usePointerCoarse` — primary pointer
coarse). A narrow desktop window keeps instant mouseup-anchoring; a portrait tablet
still gets touch anchoring.

The source/diff `mouseup` selection path swaps for a debounced `selectionchange`
listener raising a floating **"Add feedback" pill** (`AddFeedbackPill`):

- The anchor/quote/rect are captured **at selectionchange time** — iOS collapses the
  selection on tap — and the position clamps into the viewport.
- The pill sits **under** the selection: the native iOS Copy/Look Up callout owns
  the space above. It flips above only when there's no room at the viewport bottom.
- **Any scroll dismisses it.**
- While the anchored composer already holds text, the pill reads **"Quote in note"**
  and quotes in one tap.

Line-number taps anchor through the existing gutter path (`touch-manipulation`).

**Deferred**: tap-tap range extension. Rendered comment mode uses the preview
runtime and its native DOM/text target, never a parent-page source selection.

## Ergonomics

Below `md`:

- **Compact ~40px touch targets** — the shared `Button` gets `min-h-9`, icon buttons
  `size-9`. Real-device feedback found full 44px CTAs too tall. The **h-8 header
  stack** — pane toolbar, file headers, summary bars — is deliberately exempt and
  stays `h-8`.
- **≥16px composer/input fonts** via `max-md:text-base` (1rem = 18px at the default
  root size, `main.css --r3-font-size`), so iOS doesn't zoom the page on focus (it
  does for any field under 16px). A user who shrinks the root font below 16px trades
  that back.
- Composer placeholders use the same plain action text on both tiers, without
  keyboard-only hints.
- A composer taller than its pane reveals **top-aligned** (label + quote first), not
  bottom-aligned.
- Hover-reveal affordances are forced visible on `pointer-coarse:`.
- The diff gutter compresses 3rem→2.25rem per column (files view 3.5rem→2.5rem),
  with the new-side sticky pin following.
- `interactive-widget=resizes-content` on the viewport meta.

## Owed

A real-device **iOS Safari pass** is still owed before touch anchoring is called
done.
