# r3 — Understand what's built. Steer what's next.

[![npm version](https://img.shields.io/npm/v/@hyperlogue/r3?color=6164ff&logo=npm&logoColor=white&label=%40hyperlogue%2Fr3)](https://www.npmjs.com/package/@hyperlogue/r3)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![platforms: macOS, Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
[![live demo](https://img.shields.io/badge/live-demo-6164ff?logo=googlechrome&logoColor=white)](https://hyperlogue.github.io/r3/demo/)

A local workspace for reviewing HTML pages, Markdown documents, and code from
your AI agents. Leave comments at precise locations in a document and send
feedback to your agent.

[Website & documentation](https://hyperlogue.github.io/r3/) ·
[Live demo](https://hyperlogue.github.io/r3/demo/)

![Reviewing a UI prototype in r3 with anchored comments and agent replies](site/assets/fieldwork-privacy-light.png)

## Install

Install the publishing skill, then choose your coding agent when prompted:

```sh
npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global
```

No global r3 installation is required. Then ask your agent:

> Publish this project's README to r3 so I can review it.

Open the link, leave comments, and click **Send to agent** to request revisions.

[Other installation methods](https://hyperlogue.github.io/r3/docs/get-started/#other-installation-methods)

## Feature highlights

### Point to exactly what needs changing

Anchor a comment to a UI element and keep the agent's reply beside the target.
Follow up in the same thread when a detail still needs work.

![A comment anchored to a button, with an agent reply and a follow-up requesting a spacing change](site/assets/fieldwork-comment-light.png)

### Review proposals with the discussion in view

Read a document alongside questions and agent replies. Jump from a reply to its
linked fix, then resolve the thread when you're satisfied.

![A project visibility proposal beside a discussion clarifying access rules and linking to the fix](site/assets/fieldwork-brief-light.png)

### Check the fix side by side

Compare the original and proposed fix at the commented location, with the review
thread still visible.

![Original and revised button spacing shown side by side alongside the comment that requested the change](site/assets/fieldwork-comparison-light.png)

### Give feedback on a specific video moment

Attach a comment to a timestamp and region in a video. Frame previews in the
thread show the detail you flagged and the agent's proposed fix.

![A video paused at two seconds with a highlighted date label and frame previews in the review thread](site/assets/fieldwork-media-video-light.png)
