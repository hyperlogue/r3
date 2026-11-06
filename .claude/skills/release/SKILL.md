---
name: release
metadata:
  internal: true
description: Prepare or cut an r3 release using changelog review through an r3 artifact, then commit and tag the approved version.
---

# Releasing r3

1. Draft the next changelog entry in a temporary directory. Use a dated version
   heading and only `New`, `Fixed`, and `Removed` sections, omitting empty ones.
   Describe user-visible changes in concise bullets with bold lead-ins. Preserve
   prior entries. Include the version's compare-link definition.
2. Publish the draft as a files artifact titled `r3 vX.Y.Z changelog`, with version
   label `vX.Y.Z`, following the public
   [publishing skill](../../../skills/publish-artifacts-to-r3/SKILL.md). Share its
   URL. Revise that artifact during review; keep repository files unchanged.
3. The human archives the artifact to approve it. Do not archive on their behalf.
   Verify its archived state and read the final comments and archive message.
   Proceed after approval without asking for a second confirmation.
4. Apply the approved notes and update the version sources and npm platform pins
   checked by the release scripts. Run the repository checks from `AGENTS.md`.
5. Commit the approved release, then create its annotated `vX.Y.Z` tag on that
   commit with tag subject `r3 vX.Y.Z`. Leave pushing to the user unless requested.
6. If asked to push, inspect the actual Actions result and report it. A release
   waiting for its deployment approval is not a completed publication.

Published GitHub releases are configured as immutable outside this repository.
Recover a published mistake with a new patch release; moving a published tag
requires an explicit request and changes to that external protection.

npm trusted publishers are configured externally for `release.yml` and the
`release` environment. Renaming either requires updating all package registrations.
New package names require an initial publication and trusted-publisher setup.
