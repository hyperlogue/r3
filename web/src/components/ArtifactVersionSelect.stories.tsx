import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ArtifactVersion } from "../../../shared/artifacts.ts";
import { ArtifactVersionSelect } from "./ArtifactVersionSelect.tsx";

const versions: ArtifactVersion[] = [1, 3, 4].map((seq) => ({
  artifactId: "artifact_example",
  seq,
  kind: "files",
  entrypoint: null,
  fileCount: 2,
  publicationKey: `publication-${seq}`,
  contentHash: "",
  publishedBy: { role: "human", sessionId: null },
  label: seq === 1 ? "Initial" : null,
  summary: null,
  provenance: {},
  createdAt: "2026-09-11T12:00:00Z",
  publishedAt: "2026-09-11T12:00:00Z",
}));
const meta = {
  title: "Components/ArtifactVersionSelect",
  component: ArtifactVersionSelect,
  args: { versions, selected: null, onChange: fn() },
} satisfies Meta<typeof ArtifactVersionSelect>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PublishedHistory: Story = {
  render: function Interactive(args) {
    const [selected, setSelected] = useState<number | null>(null);
    return <ArtifactVersionSelect {...args} selected={selected} onChange={setSelected} />;
  },
};
export const ChoosePublication: Story = {
  ...PublishedHistory,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Published version" }));
    await userEvent.click(canvas.getByRole("option", { name: "Version 1 · Initial" }));
    await expect(canvas.getByRole("button", { name: "Published version" })).toHaveValue("1");
  },
};
export const MissingImportedVersion: Story = { args: { selected: 2 } };
export const Unpublished: Story = { args: { versions: [] } };
