import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { artifactFixture, artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { ArtifactThreads } from "./ArtifactThreads.tsx";

const meta = {
  title: "Components/ArtifactThreads",
  component: ArtifactThreads,
  args: {
    detail: artifactFixture,
    context: { versionSeq: 1, representation: "source" },
    onLocate: fn(),
    onJumpRef: fn(),
    onCollapse: fn(),
  },
  parameters: { queryData: [[["artifact-watchers", artifactFixture.id], []]] },
  decorators: [
    (Story) => (
      <div className="h-[720px] max-w-lg border border-neutral-300">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactThreads>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeRenderedThread: Story = {};
export const AgentWorking: Story = {
  args: {
    detail: {
      ...artifactFixture,
      feedback: [
        {
          ...artifactFixtureFeedback,
          claim: {
            feedbackId: artifactFixtureFeedback.id,
            sessionId: "design-agent",
            claimedAt: "2026-09-11T12:00:00Z",
            renewedAt: "2026-09-11T12:00:00Z",
            expiresAt: "2026-09-11T13:00:00Z",
          },
        },
      ],
    },
  },
};
export const ImportedTarget: Story = {
  args: {
    detail: {
      ...artifactFixture,
      feedback: [
        {
          ...artifactFixtureFeedback,
          target: { kind: "artifact" },
          legacy: {
            source: { file: "notes.md", line_start: 8, line_end: 8, quote: "Original text" },
          },
          replies: [],
        },
      ],
    },
  },
};
export const Archived: Story = {
  args: { detail: { ...artifactFixture, state: "archived", archivedAt: "2026-09-11T13:00:00Z" } },
};
