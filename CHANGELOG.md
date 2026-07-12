# Changelog

All notable changes to r3 are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-07-12

### Added

- **Markdown messages.** Feedback bodies and replies render as safe Markdown
  (client-side, markdown-it with `html:false` — raw HTML is escaped, never
  injected). Single newlines keep reading as line breaks; only explicit
  `http(s)://` URLs auto-link.
- **`@path:Lx-y` code refs.** An agent-authored ref in a message becomes a
  click-to-scroll chip that jumps the pane to that file/line (keyboard-operable:
  the chip is a real focusable link). Replies capture `ref_version` at post time
  — the latest diff round or content snapshot — so a ref keeps pointing at the
  code as it was written; the column is auto-migrated on daemon start, and the
  CLI help, agent prompt, and `r3 guide` document the syntax and the
  snapshot-then-reply ordering that pins old vs. new.
- **Quote bubbles.** Selecting text in an agent reply raises "Quote in reply";
  selecting file-pane code while an anchored note already has text raises
  "Quote in note". Both drop the selection into the composer as a `>` blockquote
  with the caret placed after it.
- **Attention-first feedback ordering.** Active-tab cards where the agent had
  the last word float to the top, each marked with a "your turn" dot, above a
  "no response needed" divider; replying or resolving sinks a card, a fresh
  agent reply raises it.
- **Auto-growing composers.** The feedback, reply, and inline-edit textareas
  grow with their content up to a line cap, then scroll; a long draft opens
  already expanded.

### Changed

- Reply threads fold to the last three replies instead of two (version-pinned
  answers often split across replies).
- Locating a feedback no longer scrolls the file pane when the anchored lines
  are already fully in view — the highlight rings in place.
- Roomier version-picker rows in the snapshot select, matched to the round
  select's scale.

### Fixed

- Selecting code to copy while a half-written note was open no longer silently
  re-points the note's anchor; the gesture now raises the quote bubble instead.
- Bare filenames whose extension collides with a TLD (`README.md`, `setup.py`)
  no longer render as external links inside messages.
- Quote-bubble dismiss listeners attach only while a bubble is showing, instead
  of one document-wide selection listener per feedback card.

### Removed

- The nightly build workflow and its rolling `nightly` pre-release.
- The `@path:Lx-y` mention-insertion flow in composers — humans quote code as
  blockquotes via the bubbles; `@ref`s are agent-authored syntax.

## [0.2.0] - 2026-07-09

- Made the daemon fully repo-agnostic: every request resolves its repo context
  fresh; dropped the ambient default root.
- Fixed the from-source daemon to spawn with the r3 repo as cwd so the SPA
  bundles (Tailwind plugin resolution), and browser-lowered the SPA CSS in
  compiled binaries (un-lowered nesting broke placeholder dimming).
- Dropped the nvim open-in-editor feature and the `R3_BINARY` override.
- The npm launcher (`@hyperlogue/r3`) now shows the project README on its
  npm page.

## [0.1.0] - 2026-07-09

Initial public release: the per-user daemon + CLI + SPA in one binary — diff
and files reviews, anchored feedback with quote-first re-anchoring, replies,
diff rounds, content snapshots, the watch/submit agent loop, and the
GitHub/npm release pipeline.

[0.3.0]: https://github.com/hyperlogue/r3/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hyperlogue/r3/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hyperlogue/r3/releases/tag/v0.1.0
