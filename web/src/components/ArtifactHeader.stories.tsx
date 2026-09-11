import type { Meta, StoryObj } from "@storybook/react-vite";
import { artifactFixture } from "../artifact-fixtures.ts";
import { ArtifactArchiveDialog, ArtifactHeader } from "./ArtifactHeader.tsx";

const meta = {
  title: "Components/ArtifactHeader",
  component: ArtifactHeader,
  args: { detail: artifactFixture, onDeleted: () => {} },
} satisfies Meta<typeof ArtifactHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const ArchivedWithHistory: Story = {
  args: {
    detail: {
      ...artifactFixture,
      state: "archived",
      events: [
        {
          id: "event_example",
          seq: 1,
          artifactId: artifactFixture.id,
          event: "archived",
          operationKey: "fixture-archive",
          actor: { role: "human", sessionId: null },
          message: "The first iteration is complete. We'll revisit the chart next week.",
          createdAt: artifactFixture.updatedAt,
        },
      ],
    },
  },
};
export const ArchiveDialog: Story = {
  render: () => (
    <ArtifactArchiveDialog artifactId={artifactFixture.id} onCancel={() => {}} onDone={() => {}} />
  ),
};
