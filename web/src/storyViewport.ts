// Storybook-only (imported by *.stories.tsx, never by app code): the shared
// phone-frame viewport parameters for Mobile stories, so the canonical phone
// size lives once instead of copy-pasted per story. The max-md: /
// pointer-coarse: variants key on the real viewport, not a wrapper width, so a
// Mobile story must set an actual sub-md viewport — pass a wider frame only
// when a fixed-width story decorator needs the room (FeedbackPanel's 440px
// panel frame).
export function phoneViewport(width = 390, height = 780, name = "Phone") {
  return {
    viewport: {
      viewports: {
        phone: { name, styles: { width: `${width}px`, height: `${height}px` } },
      },
      defaultViewport: "phone",
    },
  };
}
