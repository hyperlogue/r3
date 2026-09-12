import type { Meta, StoryObj } from "@storybook/react-vite";
import { artifactFixture } from "../artifact-fixtures.ts";
import { ArtifactSummary } from "./ArtifactSummary.tsx";

const meta = {
  title: "Components/ArtifactSummary",
  component: ArtifactSummary,
  args: {
    versionSeq: 1,
    source: artifactFixture.versions[0].summary,
    onTarget: () => {},
    onJumpRef: () => {},
  },
} satisfies Meta<typeof ArtifactSummary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const PublishedVersion: Story = {
  args: {
    versionSeq: 2,
    source: "The navigation now groups related pages. Start at @index.md:L3-5.",
  },
};
