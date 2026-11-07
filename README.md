# r3 — Understand what's built. Steer what's next.

[![npm version](https://img.shields.io/npm/v/@hyperlogue/r3?color=cb3837&logo=npm&label=%40hyperlogue%2Fr3)](https://www.npmjs.com/package/@hyperlogue/r3)
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
