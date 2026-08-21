---
name: mobile-tier
description: r3's phone-tier (below Tailwind md/768px) design — the isolate-don't-interleave rule, web/src/mobile/ containers, the bottom bar + 3-state feedback sheet, sticky toolbar/--pane-sticky-h mechanics, touch selection anchoring via AddFeedbackPill and usePointerCoarse, and the compact-target/16px-font ergonomics. Use when changing anything that renders below md, touching web/src/mobile/, adding max-md:/pointer-coarse: classes, working on touch selection or the mobile sheet, or debugging a phone/tablet layout.
---

# The phone tier

This file is the **design source of truth** for r3 below Tailwind `md` — update it
here when the mobile design changes.

Phones are **not first-class**: no productive authoring is expected. But reading
code, switching rounds/snapshots, reading feedback, resolve/submit, replying, and
adding feedback all work below `md` (768px). Portrait tablets keep the desktop
layout.

## The prime rule: isolate, don't interleave

Mobile must not add complexity to desktop code.

- All mobile UI lives in **`web/src/mobile/`**, and **desktop components never
  import from it**.
- Existing components get only **inert `max-md:` / `pointer-coarse:` class
  tweaks**. The one exception is `JumpToFile`'s inline
  `matchMedia("(pointer: coarse)")` probe, which suppresses autofocus on touch — it
  can't import `usePointerCoarse` without breaking the isolation rule.
- The **single mount point** is `ReviewView`, which swaps the side dock for
  `MobileReviewChrome`. Panel and domain state never fork, and the same
  `FeedbackPanel` renders with the same props either way.

`web/src/mobile/` holds containers **only**: `useIsMobile` + `usePointerCoarse`
(both over `useMediaQuery`), `MobileReviewChrome` (bottom bar + the 3-state
feedback sheet), and `AddFeedbackPill` (the touch selection-anchor pill).

**Side-by-side diffs never render below `md`.** Two code columns don't fit a phone
pane, so `ReviewView` forces `layout="unified"` and `PaneToolbar` hides the toggle
(`max-md:hidden`, an inert class — desktop components still don't import from
`mobile/`). The override deliberately does **not** write the persisted preference,
so a split-preferring reader gets split back on a wide viewport.

## Layout

The sidebar hides. The pane toolbar wraps into stacked full-width rows —
round/snapshot selector (full-bleed trigger, chevron far right) · the round
summary · the buttons.

The whole header stack (review header, review summary, toolbar rows) mounts
**inside the scroll pane** on mobile. The review header + summary scroll away with
the code, while the **toolbar sticks** at the pane top and each file header pins
just below it. The toolbar's live height rides on the pane as **`--pane-sticky-h`**,
which `FileCard`'s header `top` and the anchor-in-view test both read (unset = 0 on
desktop). So the sticky stack is toolbar + file header, the code gets the full
height between the navbar and the bottom bar, and **the pane stays the one scroll
container**.

Large plain-file reviews progressively hydrate file bodies through the shared
`web/src/progressive.tsx` layer on both tiers. Every file keeps a stable measured
block in that same pane (so sticky headers, the scroll spy, file picker, and
feedback jumps retain one geometry), but only bodies within the preload band are
mounted; one shared observer replaces a scroll/touch listener set per offscreen
file. This is shared scale behavior, not a mobile fork.

A persistent bottom bar (`Feedback · N open` — the whole bar is the toggle; watcher
presence shows only inside the panel) toggles a bottom **sheet** hosting the panel,
with three discrete tap-only states:

1. **closed**
2. **composer peek** — a short sheet: the composer over the still-visible code,
   raised by any anchor gesture
3. **full**

Locate/ref jumps close the sheet before scrolling the code pane.

## Navigation

The shared `JumpToFile` picker is a toolbar button on **both** tiers: a flat
filterable list with viewed ticks, filter input pinned at the bottom, Enter jumps
to the top match. Popover on desktop, sheet below `md`.

## Anchoring (touch)

Keyed on the **pointer, not the width tier** (`usePointerCoarse` — primary pointer
coarse). A narrow desktop window keeps instant mouseup-anchoring; a portrait tablet
still gets touch anchoring.

The document-`mouseup` selection path swaps for a debounced `selectionchange`
listener raising a floating **"Add feedback" pill** (`AddFeedbackPill`):

- The anchor/quote/rect are captured **at selectionchange time** — iOS collapses the
  selection on tap — and the position clamps into the viewport.
- The pill sits **under** the selection: the native iOS Copy/Look Up callout owns
  the space above. It flips above only when there's no room at the viewport bottom.
- **Any scroll dismisses it.**
- While the anchored composer already holds text, the pill reads **"Quote in note"**
  and quotes in one tap.

Line-number taps anchor through the existing gutter path (`touch-manipulation`).

**Deferred**: tap-tap range extension, and summary selection via the pill.

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
- Composer **placeholders drop their keyboard-shortcut hints** on a coarse pointer
  (no hardware keyboard) — `ReviewView` feeds the pointer fact to `FeedbackPanel` as
  a `coarse` prop.
- A composer taller than its pane reveals **top-aligned** (label + quote first), not
  bottom-aligned.
- Hover-reveal affordances are forced visible on `pointer-coarse:`.
- The diff gutter compresses 3rem→2.25rem per column (files view 3.5rem→2.5rem),
  with the new-side sticky pin following.
- `interactive-widget=resizes-content` on the viewport meta.

## Owed

A real-device **iOS Safari pass** is still owed before touch anchoring is called
done.
