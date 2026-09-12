# Browser support requirement

Artifact rendering must work in stable Firefox, Chrome, and Safari on macOS and
iOS from the preceding six months. Include the browser release that was current
at the start of the window. This is a rolling product requirement, not a claim
that the current implementation passes it.

Support includes interactive HTML, retained Markdown, rendered comments and
Locate, published-document navigation, version switching, and explicit camera
and microphone consent. Source-only or script-disabled rendering does not satisfy
the interactive HTML requirement. Localhost and HTTPS application hosting must
use the same supported workflow.

## Initial release window

The initial window is March 12–September 12, 2026. Its main stable release trains
start at Chrome 146, Firefox 148, and Safari 26.3. Test each intervening release
train as well as its oldest and newest endpoints. Record exact browser and OS
builds in acceptance results; a user-agent override is not a browser test.

- [Chrome 146 stable release](https://chromereleases.googleblog.com/2026/03/stable-channel-update-for-desktop_10.html)
- [Firefox 148.0.2 release](https://www.mozilla.org/en-US/security/advisories/mfsa2026-19/)
- [Safari and iOS release history](https://support.apple.com/en-us/100100)

Maintenance branches need separate entries when they receive browser updates in
the window. In particular, do not infer a Safari engine version from an iOS
version number or silently discard older iOS branches that still receive WebKit
updates. Refresh the release inventory as the window advances.

## Acceptance evidence

Each result must distinguish the shipping browser and operating system from a
patched engine or an emulated viewport. Playwright Firefox/WebKit builds are
useful for development, but Linux WebKit and an iPhone viewport do not establish
Safari support. Use actual Safari on macOS and iOS for their acceptance results.
[Playwright documents these differences](https://playwright.dev/docs/browsers#webkit).

The common suite must cover:

- Initial HTML/Markdown rendering, publisher JavaScript, local modules and assets,
  interaction, and native navigation through published documents.
- Rendered selection, feedback creation and replies, Locate, pinned versions, and
  switching back to an earlier publication.
- Parent/application and sibling-artifact isolation, credential handling, and
  the exact network guarantee advertised by the selected mode.
- Separate r3 and browser device consent, browser denial and grant, actual media
  delivery, stopping physical tracks, and revocation on navigation and departure.
- Touch selection, scrolling, keyboard and permission dialogs on actual iOS.

Use fresh profiles, controlled endpoints and temporary stores. Device automation
uses synthetic devices while retaining real browser permission decisions. Record
physical-device and native iOS checks separately; do not replace them with mocked
success or call an unexecuted case supported.

## Network protection and acceptance gap

Each preview attempts verified Connection Allowlist protection first. A browser
that fails only network enforcement shows a risk prompt before any publication
bytes load. Acceptance is remembered for this r3 origin/browser and permits a new
`compatible` context with restrictive CSP and sandbox headers. It does not claim
complete outbound blocking. The toolbar uses an amber network indicator; the green
lock is reserved for verified enforcement. Broader external-resource and device
consent remain separate and are never remembered across version visits.

The browser acknowledgment resolves the product tradeoff without pretending CSP
is a complete network firewall. It does not itself establish browser compatibility:
the full release/platform matrix above still requires execution. See the
[security model](../../.claude/skills/security-model/SKILL.md) and
[executable verification guide](verification.md) for the protocol and evidence.
