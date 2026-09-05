# Changelog

All notable changes to r3 are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.13.0] - 2026-09-04

### Added

- **r3 can actively wake up session to send notifications.** `r3 listen <id>`
  registers the current Claude Code or Codex session and returns. When the
  reviewer submits feedback, approves, or abandons the review, r3 sends a
  notification into that agent session; the agent can then fetch the feedback
  with `r3 prompt`. Previously, agents must keep an `r3 watch` long running
  process to receive feedback.
- **Session ids are recorded automatically.** Reviews and work-in-progress
  badges identify the agent session involved. The UI shows a short id and lets
  you copy the full one, making it easier to find or contact the same session.

### Changed

- **Large reviews stay steadier while loading and typing.** Deferred file cards
  reserve their expected height so the scrollbar does not keep shifting as you
  move through the review, and desktop paint containment roughly halves the
  measured composer-keystroke cost on a 200-file review.
- **The agent guide better explains how to use r3.** It now starts with which
  kind of review to create and walks through receiving feedback, claiming work,
  replying, and sending another revision.
- **Anchoring feedback in scratch reviews is simpler.** Agent commands can refer
  to a scratch file by its displayed filename, such as `notes.md`.

### Fixed

- **A failed listener hand-off no longer looks successful.** The UI reports when
  Submit reached nobody, repeated Submits cannot be deduplicated into silence,
  and stale registrations no longer lock another agent out of the review.
- **Marking a rendered Markdown table row keeps its columns aligned.** The
  feedback bar no longer inserts an apparent empty cell ahead of the row.

## [0.12.0] - 2026-08-31

### Added

- **Fold the feedback dock to a rail.** Collapse the panel to a strip that keeps the
  open count and a status glyph, and floats the composer next to the code when
  you anchor a note there.
- **Resolved feedback is unmistakable.** A resolved card takes a success wash
  and a `✓ resolved` pill.

### Changed

- **Large reviews got a lot faster.** A 200-file review scrolls smoothly,
  highlighted code arrives 59% lighter per line, a keystroke in a feedback
  composer costs one box instead of the whole page, and a multi-megabyte
  response compresses off the daemon's event loop so live updates and an agent
  blocked on `r3 watch` keep flowing.

### Fixed

- **A files review whose files have since been deleted stays quiet.** The card
  reads "not in the working tree" instead of re-requesting the missing file
  every time you scroll past it.
- **Returning to a backgrounded tab re-renders the review you are on**, not
  every review that tab has visited.

## [0.11.0] - 2026-08-23

### Added

- **Mermaid diagrams render in a reviewed `.md`.** A ` ```mermaid ` flowchart
  or sequence diagram now shows as a diagram — the server renders it to SVG —
  instead of highlighted source. Any other diagram kind falls back to an ordinary
  code fence.

### Changed

- **A large file no longer stalls the daemon.** Syntax highlighting runs off the
  daemon's thread, so nothing holds up live updates or an agent blocked on
  `r3 watch` while a big blob is highlighted. A diff review also loads only the
  round you are looking at, expand-context reuses the diff it already derived,
  and marking lines or dragging the gutter stays smooth in long files.
- **Snapshot and expand-context diffs use Myers**, the algorithm git itself uses.
  A small edit between two large files now reads as a small edit rather than a
  full rewrite.

### Fixed

- **A binary or oversize file in a files review is marked as such**, instead of
  being reported as deleted or quietly dropped from a snapshot.
- **Feedback handed off to `r3 watch` can't be lost.** The hand-off is drained in
  one step, so two agents on the same review can't both claim it and a note
  whose text resembles r3's own output no longer reads as an empty round.
- **Removing a diff review's last round leaves it empty**, instead of falling
  back to whatever the working tree holds now.
- **`r3 reanchor` checks where you point it** — the path and line range are
  validated on the way in, and the next automatic pass re-verifies the result
  rather than trusting it.
- **A round or snapshot never reuses a number an older reply still refers to**,
  so a `@path:Lx-y` ref keeps pointing at the code it was written against.
- **`r3 guide` matches what the CLI accepts** for `files rm`, `snapshot rm`, and
  scratch reviews.
- **Forgetting a repo clears its reviews from open tabs.**
- **Editing a note you already handed off marks it undelivered right away.**
- **Approve says why it is disabled** when you hover it.
- **Jumping to a file keeps the current-file marker moving** instead of freezing
  it where it was.

## [0.10.1] - 2026-08-22

### Added

- **One agent watches a review at a time.** Two `r3 watch` clients on the
  same review no longer race the round. A second watcher is refused.

### Fixed

- **Editing a sent reply sends the new wording to the agent.** The next
  Copy prompt, Submit, or `r3 watch` includes the correction.

## [0.10.0] - 2026-08-21

### Added

- **Claim work in flight.** `r3 claim <feedback_id>...` shows in the UI
  which notes an agent is handling, so a long edit no longer looks like
  the agent wandered off.
- **Fenced code in a reviewed `.md` is highlighted** with the same syntax
  theme as the code view.
- **Large files reviews stay scrollable.** Bodies load as you approach
  them, instead of all at once.

### Changed

- **Approve no longer waits on open notes you chose not to chase.** It
  blocks on unread content, or on an item the agent has claimed.

### Fixed

- **Re-anchoring keeps the quote you marked**, instead of rewriting the
  note to whatever lines it was pointed at.
- **`r3 stop` kills a stuck daemon** instead of abandoning it, so later
  starts can recover.
- **A spawn timeout names a sandbox** that can't reach localhost, instead
  of only blaming a stuck daemon.
- **Directory rows in the file tree line up** with the files at the same
  depth.

## [0.9.3] - 2026-08-15

### Changed

- **Focusing a note no longer moves the file pane.** Resolving or replying
  advances to the next card — and `j`/`k` walk the list — with each anchor
  ringing where it already is; the pane jumps only on an explicit locate: a
  card's file:line header, a reply's pin, or `o`.

### Fixed

- **Selecting rendered Markdown anchors exactly what you picked.**
  - A quote crossing a link, a table row, bold text, or an `&nbsp;` is matched
    against the text the browser shows, so it no longer comes back "the text
    this refers to changed" the moment it's saved.
  - When a doc repeats a phrase, the note — and its highlight — lands on the
    copy you selected, not a near-duplicate elsewhere in the file.
  - A selection longer than the quote cap keeps its full line range instead of
    being rewritten to the quote's first lines.
  - A triple-clicked paragraph no longer extends the anchor into the block
    after it, and a drag released over the feedback panel keeps the paragraph's
    whole text in the quote.
- **Relative links between reviewed docs work.** A `[setup.md](setup.md)` link
  in a rendered `.md` opened a URL that never existed; it now jumps to that
  file's card in the review — `#heading` fragments included — and a link to a
  file outside the review renders as dead instead of looking live and doing
  nothing.

## [0.9.2] - 2026-08-12

### Fixed

- **Feedback on rendered Markdown anchors to what you selected.** A note on a
  bullet, a table cell, or a phrase mid-paragraph was recorded as the whole
  list, table, or paragraph, and now lands on the lines its quote occupies.
- **Clicking prose in a `.md` review no longer hijacks the page.** Only a click
  on the highlighted quote focuses its feedback, instead of a click anywhere in
  the block around it.

## [0.9.1] - 2026-08-11

### Fixed

- **Space and Tab focus the feedback composer again.** A note anchored from the
  file pane opens unfocused so your selection survives; either key now puts the
  caret in it instead of re-firing the last button you clicked.

## [0.9.0] - 2026-08-10

### Changed

- **Untrusted Markdown no longer loads remote images.** An image in
  agent-authored feedback or in a reviewed `.md` renders as a link you can click
  instead of fetching the moment you open the review. Reviewed `.md` also stops
  promoting bare filenames like `setup.py` to external links, and its links open
  in a new tab rather than navigating the app away.
- **The "agent is watching" indicator can no longer be faked.** While `r3 watch`
  is running, the feedback panel shows the agent as connected and swaps _Copy
  prompt_ for _Submit_. Any website open in your browser could trigger that
  against your local daemon, so r3 could offer to hand your feedback to an agent
  that was never there. Registering as a watcher now needs the API token;
  `r3 watch` itself works as before.

### Fixed

- **Feedback keeps the line range you picked.** A note dragged over 10 lines was
  rewritten to the first 4 on the next render, and `r3 reanchor --quote` blanked
  a note's range entirely. `r3 reanchor --file --line` now re-derives the quote,
  so the repair sticks instead of drifting back to "outdated".
- **Editing a reply hands it to the agent again** — a correction typed into an
  already-delivered reply was marked as sent and never arrived.
- **A large file no longer freezes the daemon.** One 2 MB file blocked every
  request, live update, and waiting `r3 watch` for over a minute; large files now
  render unhighlighted. Syntax highlighting also holds a memory budget rather
  than a file count, which had it retaining gigabytes.
- **Diff line numbers are correct** for patches whose blank context lines lost
  their leading space in transit, and two hunks separated by a gap no longer
  merge into one under a fabricated `@@` header.
- **Deleting a review can no longer delete another review's scratch files.**
- **The daemon survives a background error**, and a hung `git` call times out
  instead of silently ending file-watching for the rest of the session.
- **`r3 watch` survives a daemon restart** instead of exiting with a code the
  loop doesn't define and dropping the review.
- **Reply pins are validated against the round**, so a line the round never had
  is refused rather than stored as a jump that goes nowhere.
- **In-progress composer drafts** are no longer skipped at startup and then
  overwritten, and the **login-token Copy button** works on the plain-HTTP
  deployments those tokens exist for, where it silently did nothing.
- A malformed `--meta` filter no longer returns a 500.
- **Large files and long diff rounds open folded again**, instead of expanded.
  The released binary was built against a development React that ran every
  effect twice, which defeated the fold-on-open the row count is meant to
  trigger.
- **Faster reviews**: the released binary is ~200 KB smaller, a file change
  refetches only that file rather than every open one, and diff rounds and
  worktree lookups are cached instead of recomputed on every request.
- **Browser demo**: expand-context works on the round the demo's agent appends,
  and returning visitors get the current fixtures instead of a stale copy.

## [0.8.0] - 2026-08-08

### Added

- **Drive the review loop from the keyboard.** `?` lists the map: `j`/`k` step
  through feedback, `o` jumps to a note's anchor, `r` replies, `e` resolves, `n`
  starts a note, `S` hands the review to the agent; `]`/`[` step files, `f`
  jumps to one, `z`/`Z` fold, `x` marks viewed, `a` annotates the current file;
  `<`/`>` walk diff rounds and snapshots, `\` toggles side-by-side. Every
  shortcut fires a control that's already on screen, under that button's own
  disabled condition. Marking a line range stays a mouse drag.
- **The jump-to-file picker takes the keyboard**: ↑/↓ (or Ctrl-p/Ctrl-n) move
  the selection and Enter opens it.
- **Keyboard focus is visible.** Tabbing through the UI now shows a focus ring.

### Changed

- The browser demo now shows **side-by-side diffs and expand-context**, so both
  can be tried without installing anything.

### Fixed

- Selecting across a **side-by-side diff** no longer puts blank lines into the
  quote where one column had fewer lines than the other. Since the quote is what
  re-anchoring searches for, those blanks were not cosmetic.
- The two columns of a side-by-side diff **stay vertically aligned** across
  expandable gaps; each one drifted them a quarter line apart.
- **Dragging the line gutter** now caps the quote the way a text selection
  already did — a 40-line drag stored a 40-line quote, which is exactly what
  re-anchoring relocates worst.
- **Jumping to a feedback centers its line** instead of always landing 30% down
  the pane.
- The **current-file highlight** — in the file browser and the jump-to-file
  picker — is right on open and while you scroll. It was picked against a hidden
  8px line rather than where a header actually pins, which on a phone could
  highlight a file behind the toolbar, and on opening a review it marked no file
  at all until you scrolled.

### Removed

- Releases no longer ship a **`SHA256SUMS`** manifest — GitHub publishes a
  sha256 digest for every release asset, and a second copy is a second thing
  that can disagree.

## [0.7.0] - 2026-08-01

### Added

- **Side-by-side diffs.** A toolbar toggle switches between one unified column
  and paired old/new columns, and the choice sticks across reviews. Anchoring,
  highlighting, and viewed marks work as they do in unified. Phones stay unified.
- **Expand the context around a change.** The gap between two hunks becomes a
  control: reveal 20 more lines from either end, or the whole gap. Revealed lines
  are ordinary code rows you can anchor feedback on, so a note is no longer
  confined to the three lines around a change. Applies to snapshot diffs
  immediately, and to diff rounds captured from this version on — older rounds
  stored only three lines of context, so they show no control.

### Changed

- Diff rounds are **captured with far more context than they render**, which is
  what makes expanding possible later. Stored review data grows roughly 3× per
  round; very large files are capped and still expand 25 lines each way.

## [0.6.0] - 2026-07-27

### Added

- **Tab focuses the note composer.** The selection composers already took Space
  to jump focus into the note input; forward Tab now does the same (Shift+Tab
  still navigates backward).

### Changed

- Syntax highlighting moves to **Shiki 4**, with its newer grammars and themes.

### Fixed

- Selecting text inside a **4-space-indented Markdown code block** now raises
  the composer. The anchor gesture was dead in indented blocks — every fenced
  block around them worked, so only those regions were unresponsive.
- A failed **Resolve, Reopen, or Delete** now shows its error. Those actions
  move the card out of the visible tab, and the remount wiped the banner, so a
  failure just snapped the card back with no message.
- **Replying floats a review back to the top** of the reviews list; a posted
  reply wasn't re-stamping the review's `updated_at`.
- Clicking an `@path:Lx-y` ref no longer **yanks the pane off the live view**
  when the snapshot it points at is what you're already looking at.

## [0.5.0] - 2026-07-19

### Added

- **Mobile-friendly review UI.** Below 768px the review becomes one pane: the
  feedback panel moves into a bottom bar + sheet, touch selections raise an
  "Add feedback" pill, and the toolbar + file headers stick while the header
  scrolls away. Reading, replying, resolving, submitting, and adding feedback
  all work on a phone; desktop is unchanged.
- **Jump-to-file picker.** A filterable file list with viewed ticks on both
  tiers — popover on desktop, bottom sheet on mobile. Picking a viewed
  (folded) file re-expands it.
- **Live browser demo.** The whole SPA runs fully in the browser at
  <https://hyperlogue.github.io/r3/demo/> — seeded reviews, a scripted agent
  answering Submit, nothing to install.
- **Persisted server config.** `r3 config show|get|set|unset` stores
  bind/port/publicUrl/allowedHosts/requireLogin in
  `$XDG_CONFIG_HOME/r3/config.json` (read below env), so a restart keeps a
  remote-serving posture instead of reverting to loopback-only.

### Changed

- Creating feedback is optimistic like the other mutations; a failed add
  restores your draft.
- Agent-authored feedback bodies render in the agent's bubble and support
  select-to-quote.
- The agent prompt nudges an initial snapshot on files reviews at hand-off.

### Fixed

- Replying over plain HTTP on a non-loopback bind no longer crashes
  (`crypto.randomUUID` is secure-context-only).
- Failed or echo-less optimistic writes reconcile instead of leaving stale
  cards or erasing newer server truth.
- Replying to a card that stays put no longer yanks focus to the next item.
- A summary note's highlight survives snapshot switches and re-anchors.
- Fewer redundant refetches: one review refetch per write, and diff rounds
  refetch only when rounds change.

## [0.4.0] - 2026-07-14

### Changed

- **Optimistic UI updates.** Most UI operations apply at the instant you click,
  instead of waiting for backend to acknowledge. This improves the user experience
  when running r3 on a remote server.
- **Replying advances focus** to the next item down, like resolving already did,
  instead of following the just-answered card down to the bottom of the list.
- **Version-switch crossfade.** Changing diff rounds or a snapshot from/to
  comparison briefly crossfades the file pane instead of hard-cutting; scroll and
  fold state are preserved.

### Fixed

- Resolving or replying to a feedback triggers a single review refetch, not three
  (a redundant self-invalidation plus a doubled SSE broadcast).
- Focusing a rendered-file or diff feedback no longer loses its yellow quote
  highlight (the summary-highlight pass was clearing the shared registry).
- The settings font-size slider no longer clips the `+` button at small sizes.
- Revoking the login token behind your own session is refused (`409`) instead of
  locking you out; the settings list marks it "this session" and disables its
  revoke. CLI (master-token) callers and bulk revoke-all are unaffected.

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

[0.13.0]: https://github.com/hyperlogue/r3/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/hyperlogue/r3/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/hyperlogue/r3/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/hyperlogue/r3/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/hyperlogue/r3/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/hyperlogue/r3/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/hyperlogue/r3/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/hyperlogue/r3/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/hyperlogue/r3/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/hyperlogue/r3/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/hyperlogue/r3/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/hyperlogue/r3/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hyperlogue/r3/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hyperlogue/r3/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hyperlogue/r3/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hyperlogue/r3/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hyperlogue/r3/releases/tag/v0.1.0
