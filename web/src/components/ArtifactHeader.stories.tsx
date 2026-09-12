import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { artifactFixture } from "../artifact-fixtures.ts";
import { phoneViewport } from "../storyViewport.ts";
import { ArtifactArchiveDialog, ArtifactHeader } from "./ArtifactHeader.tsx";

const meta = {
  title: "Components/ArtifactHeader",
  component: ArtifactHeader,
  args: { detail: artifactFixture },
} satisfies Meta<typeof ArtifactHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const Diff: Story = { args: { detail: { ...artifactFixture, kind: "diff" } } };
export const Html: Story = {
  args: { detail: { ...artifactFixture, kind: "html" } },
  render: (args) => {
    const [commenting, setCommenting] = useState(false);
    return (
      <ArtifactHeader
        {...args}
        commenting={commenting}
        onToggleCommenting={() => setCommenting(!commenting)}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "r3" })).toHaveAttribute("href", "/");
    await expect(canvas.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Active", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Comment mode" }));
    await expect(canvas.getByRole("button", { name: "Exit comment mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details" }));
    await expect(canvas.getByText(artifactFixture.id, { exact: true })).toBeVisible();
  },
};
export const Phone: Story = { ...Html, parameters: phoneViewport() };
export const LongTitle: Story = {
  args: {
    detail: {
      ...artifactFixture,
      title:
        "A long artifact title that should leave room for commenting, archiving, details, and settings",
    },
  },
};
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
