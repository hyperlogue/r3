# r3 — See your agent’s work. Steer what’s next.

Explore UI prototypes, interactive explainers, and design docs from your agent. Click directly on what needs attention, leave anchored notes, and refine the result together.

Local by default. [Connect to your own server](/docs/access/) to keep artifacts on a remote backend while agents run on your machine.

## Features

### Comment on the work. Send it to your agent.

Click a button, heading, or input and leave a note. Collect your feedback, then send it to your agent in one batch, with the exact element and viewport context.

[Watch the 18-second demo](/assets/videos/precise-feedback.mp4) · [Read transcript](/assets/videos/precise-feedback.transcript.txt)

### Follow the reply. Keep every version.

Your agent replies in the same thread and publishes revisions as new versions. Earlier versions stay available, so you can revisit the original and open the latest when you’re ready.

[Watch the 10-second demo](/assets/videos/agent-replies.mp4) · [Read transcript](/assets/videos/agent-replies.transcript.txt)

### See the fix, side by side.

Once your agent publishes a revision, open Compare from the reply. Check the original beside the fix to see whether it solves the problem.

[Watch the 10-second demo](/assets/videos/inspect-fixes.mp4) · [Read transcript](/assets/videos/inspect-fixes.transcript.txt)

### Attach images in comments.

Attach screenshots, sketches, or design mockups directly to your feedback to show your agent the intended design.

[Watch the 11-second demo](/assets/videos/image-comments.mp4) · [Read transcript](/assets/videos/image-comments.transcript.txt)

### Comment on the exact video frame.

Pause anywhere in a clip, highlight a region, and leave a note. The captured timestamp and still frame give your agent unambiguous visual context.

[Watch the 12-second demo](/assets/videos/video-comments.mp4) · [Read transcript](/assets/videos/video-comments.transcript.txt)

The homepage pairs these five features with silent, playable demos of the real r3 interface. Each lasts 10–18 seconds and has a text transcript. The recordings use fictional local data and scripted agent replies.

## Start a review

Install the publishing skill with `npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global`, choose your coding agents, then ask an agent to publish its work to r3. No global r3 installation is required.

## Then ask your agent

The homepage illustrates these prompts in a terminal. The shared publishing instruction stays in place while examples fade. Choose a prompt or pause the animation.

- **UI Prototype:** Create a project-creation form so I can review the visibility settings. Publish an HTML artifact to r3.
- **Explainer:** Explain how search ranking works with interactive sliders I can try. Publish an HTML artifact to r3.
- **Design doc:** Write a design doc for project visibility, including access rules and tradeoffs. Publish an HTML artifact to r3.

[Install the skill](/docs/get-started/#install-the-skill) · [Other installation methods](/docs/get-started/#other-installation-methods) · [Try the live demo](/demo/) · [Use cases](/use-cases/) · [Documentation](/docs/)

The homepage’s [Example Fieldwork workspace](/example/index.html) uses the real r3 React page with fictional data and scripted agent replies.
