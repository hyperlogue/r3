Example Fieldwork’s launch campaign has a static announcement and a short product clip. The copy is correct, but the date is hard to read against the background. Keep the review attached to the pixels you are actually discussing.

<div class="scenario">
<div><strong>The work</strong><p>A files artifact containing a launch image and a short, captioned video.</p></div>
<div><strong>The review</strong><p>Can a reader see the key information at the intended size, with sound off?</p></div>
</div>

## Prepare a reviewable campaign

> Read `r3 guide` and `r3 guide files`. Prepare a fictional launch image for Example Fieldwork and, when a clip is available, include it alongside the image. Keep essential information visible without sound. Publish the original media files for review, with a short note describing intended display sizes and the message each asset should communicate.

You can complete the image review before a video exists. The video steps below apply when there is a real clip to inspect; an empty player is not useful evidence.

## Review the static image

Open the image at the size it will actually be used. Select the launch-date region and add:

> The date blends into the photograph at a small size. Increase contrast in this region and leave enough space around it. Keep the headline as the first thing I notice.

The original target retains a saved full frame and the selected box. A separate annotated attachment can explain the desired placement without altering that original evidence.

## Review a specific video moment

Pause the clip where the date appears. Select the frame or region and comment:

> This caption is difficult to read before the scene changes. Keep it visible longer and use a background treatment that stays legible throughout the shot. The meaning must be clear with sound off.

The timestamp provides context, while the saved frame preserves the exact image. Seeking later may land on a neighboring frame, so the agent should inspect the snapshot supplied with the feedback.

## Compare the revised evidence

Ask the agent to reply with an explicit fix target and a saved frame from the revised publication. Use **Compare** when available to inspect the original and proposed regions together.

Then play the clip again. A still comparison can verify contrast and placement, but it cannot prove that the caption remains on screen long enough. Check timing through playback.

## Check the communication

- The date is readable at the intended display size.
- The headline remains visually primary.
- The clip communicates its key information without audio.
- The agent’s fix target points to the revised asset and frame.

Resolve the image and video concerns independently. One may be ready while the other needs another pass.

## Reproduce the publication

```sh
r3 create --kind files --dir ./fieldwork-launch \
  --title 'Example Fieldwork — launch campaign'
```

Use PNG/JPEG/static WebP for image-region feedback and browser-decodable video for frame feedback. The [media documentation](/docs/media/) explains supported targets, attachment limits, and comparisons.
