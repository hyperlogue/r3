import type { Meta, StoryObj } from "@storybook/react-vite";
import { artifactDrafts } from "../artifact-drafts.ts";
import { ArtifactComposer } from "./ArtifactComposer.tsx";

const meta = {
  title: "Components/ArtifactComposer",
  component: ArtifactComposer,
  args: { artifactId: "artifact_composer_story" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactComposer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const General: Story = { args: { artifactId: "artifact_general_composer" } };
export const RenderedTarget: Story = {
  loaders: [
    () => {
      artifactDrafts.anchor("artifact_composer_story", {
        kind: "rendered",
        versionSeq: 1,
        path: "index.md",
        locator: { selector: "a", quote: "View the comparison" },
      });
      return {};
    },
  ],
};
export const VersionedReply: Story = {
  args: { artifactId: "artifact_reply_story", replyTo: "feedback_story" },
  loaders: [
    () => {
      artifactDrafts.beginReply("artifact_reply_story", "feedback_story", {
        versionSeq: 3,
        representation: "source",
      });
      return {};
    },
  ],
};
