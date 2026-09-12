import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ArtifactPreviewNetworkControl } from "./ArtifactPreviewNetworkControl.tsx";

const meta = {
  title: "Components/ArtifactPreviewPermissions",
  component: ArtifactPreviewNetworkControl,
  args: {
    network: "external",
    devices: { camera: true, microphone: true },
    capture: { phase: "idle", camera: false, microphone: false },
    onChange: fn(),
    onStopSharing: fn(),
  },
} satisfies Meta<typeof ArtifactPreviewNetworkControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Permitted: Story = {};
export const Sharing: Story = {
  args: { capture: { phase: "sharing", camera: true, microphone: true } },
};
export const WaitingForBrowser: Story = {
  args: { capture: { phase: "requesting", camera: false, microphone: false } },
};
export const BrowserDenied: Story = {
  args: {
    capture: { phase: "error", camera: false, microphone: false, message: "Permission denied" },
  },
};
