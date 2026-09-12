import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ArtifactPreviewCompatibilityConsent } from "./ArtifactPreviewCompatibilityConsent.tsx";

const meta = {
  title: "Components/ArtifactPreviewCompatibilityConsent",
  component: ArtifactPreviewCompatibilityConsent,
  args: { onCancel: fn(), onContinue: fn() },
} satisfies Meta<typeof ArtifactPreviewCompatibilityConsent>;
export default meta;
export const Warning: StoryObj<typeof meta> = {};
