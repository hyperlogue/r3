import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { ArtifactPreviewNetworkControl } from "./ArtifactPreviewNetworkControl.tsx";

const meta = {
  title: "Components/ArtifactPreviewPermissions",
  component: ArtifactPreviewNetworkControl,
  args: {
    network: "external",
    verification: "ready",
    html: true,
    compatibilityAccepted: false,
    onForgetCompatibility: fn(),
    devices: { camera: true, microphone: true },
    capture: { phase: "idle", camera: false, microphone: false },
    onChange: fn(),
    onStopSharing: fn(),
  },
} satisfies Meta<typeof ArtifactPreviewNetworkControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Permitted: Story = {};
export const Protected: Story = {
  args: { network: "blocked", devices: { camera: false, microphone: false } },
};
export const Checking: Story = {
  ...Protected,
  args: { ...Protected.args, verification: "checking" },
};
export const Limited: Story = {
  args: {
    network: "compatible",
    compatibilityAccepted: true,
    devices: { camera: false, microphone: false },
  },
};
export const LimitedDetails: Story = {
  ...Limited,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText(/^Preview protections:/));
  },
};
export const RenderedFile: Story = { ...Limited, args: { ...Limited.args, html: false } };
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
