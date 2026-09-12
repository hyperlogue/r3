import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { ArtifactThreadPopover } from "./ArtifactThreadPopover.tsx";

const meta = {
  title: "Components/ArtifactThreadPopover",
  component: ArtifactThreadPopover,
  args: {
    feedback: artifactFixtureFeedback,
    context: { versionSeq: 1, representation: "rendered" },
    onLocate: fn(),
    onJumpRef: fn(),
    onExpand: fn(),
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] max-w-md flex-col items-stretch">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactThreadPopover>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Resolved: Story = {
  args: { feedback: { ...artifactFixtureFeedback, status: "resolved" } },
};
