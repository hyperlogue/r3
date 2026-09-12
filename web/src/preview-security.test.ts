import { expect, test } from "bun:test";
import { type PreviewSecurityState, previewSecuritySummary } from "./preview-security.ts";

const protectedPreview: PreviewSecurityState = {
  network: "blocked",
  verification: "ready",
  devices: { camera: false, microphone: false },
  capture: { phase: "idle", camera: false, microphone: false },
};

test("one protected preview never hides a weaker or unverified sibling", () => {
  const otherStates: PreviewSecurityState[] = [
    { ...protectedPreview, verification: "checking" },
    { ...protectedPreview, verification: "error" },
    { ...protectedPreview, network: "compatible" },
    { ...protectedPreview, network: "external" },
    { ...protectedPreview, devices: { camera: true, microphone: false } },
    {
      ...protectedPreview,
      capture: { phase: "error", camera: false, microphone: false, message: "Permission denied" },
    },
  ];
  for (const other of otherStates) {
    expect(previewSecuritySummary([protectedPreview, other]).state).not.toBe("verified");
    expect(previewSecuritySummary([other, protectedPreview]).state).not.toBe("verified");
  }
  expect(previewSecuritySummary([protectedPreview, protectedPreview]).state).toBe("verified");
  expect(previewSecuritySummary([]).state).not.toBe("verified");
});

test("active capture stays visible even when another preview fails", () => {
  expect(
    previewSecuritySummary([
      { ...protectedPreview, verification: "error" },
      {
        ...protectedPreview,
        network: "external",
        capture: { phase: "sharing", camera: true, microphone: false },
      },
    ]).state,
  ).toBe("sharing");
});
