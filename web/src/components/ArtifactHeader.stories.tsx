import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { artifactFixture } from "../artifact-fixtures.ts";
import { phoneViewport } from "../storyViewport.ts";
import { ArtifactArchiveDialog, ArtifactHeader } from "./ArtifactHeader.tsx";
import {
  ArtifactPreviewSecurityProvider,
  ArtifactPreviewSecuritySource,
} from "./ArtifactPreviewSecurity.tsx";

const meta = {
  title: "Components/ArtifactHeader",
  component: ArtifactHeader,
  args: { detail: artifactFixture },
} satisfies Meta<typeof ArtifactHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const FeedbackToggle: Story = {
  render: (args) => {
    const [visible, setVisible] = useState(true);
    return (
      <ArtifactHeader
        {...args}
        feedbackVisible={visible}
        onToggleFeedback={() => setVisible(!visible)}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Hide feedback" }));
    await expect(canvas.getByRole("button", { name: "Show feedback" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Show feedback" }));
    await expect(canvas.getByRole("button", { name: "Hide feedback" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};
export const Description: Story = {
  args: {
    version: {
      ...artifactFixture.versions[0],
      seq: 1,
      summary: "The navigation groups **related pages**. Start at @index.md:L3-5.",
    },
    onJumpRef: () => {},
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const popup = within(canvas.getByRole("dialog", { name: "Artifact details" }));
    await expect(popup.getByText("Description · Version 1")).toBeVisible();
    await expect(popup.getByText("related pages")).toBeVisible();
  },
};
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
    await expect(canvas.getByRole("img", { name: "HTML artifact" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Comment mode" }));
    await expect(canvas.getByRole("button", { name: "Exit comment mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    await expect(canvas.getByText(artifactFixture.id, { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Archive artifact" }));
    await expect(
      canvas.queryByRole("dialog", { name: "Artifact details" }),
    ).not.toBeInTheDocument();
    const archive = within(canvas.getByRole("dialog", { name: "Archive artifact" }));
    await expect(
      archive.getByRole("textbox", { name: "Archive message (optional)" }),
    ).toBeVisible();
    await userEvent.click(archive.getByRole("button", { name: "Cancel" }));
    await expect(
      canvas.queryByRole("dialog", { name: "Archive artifact" }),
    ).not.toBeInTheDocument();
  },
};
export const Phone: Story = { ...Html, parameters: phoneViewport() };
export const Dark: Story = { ...Html, globals: { theme: "dark" } };
export const Versions: Story = {
  args: {
    detail: {
      ...artifactFixture,
      versions: [1, 2, 3].map((seq) => ({
        ...artifactFixture.versions[0],
        seq,
        label: `Iteration ${seq}`,
        summary: `Description for version ${seq}.`,
      })),
    },
  },
  render: (args) => {
    const [selected, setSelected] = useState<number | null>(1);
    return (
      <ArtifactHeader
        {...args}
        version={args.detail.versions.find((version) => version.seq === selected)}
        selectedVersion={selected}
        onSelectVersion={setSelected}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = within(canvasElement.querySelector<HTMLElement>("[data-app-header]")!);
    await userEvent.click(nav.getByRole("button", { name: "Published version" }));
    await userEvent.click(canvas.getByRole("option", { name: "Version 2 · Iteration 2" }));
    await expect(nav.getByRole("button", { name: "Published version" })).toHaveValue("2");
  },
};
export const DarkVersions: Story = { ...Versions, globals: { theme: "dark" } };
export const PhoneVersions: Story = {
  ...Versions,
  parameters: phoneViewport(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Published version" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const popup = within(canvas.getByRole("dialog", { name: "Artifact details" }));
    await userEvent.click(popup.getByRole("button", { name: "Published version" }));
    await userEvent.click(popup.getByRole("option", { name: "Version 2 · Iteration 2" }));
    await expect(canvas.queryByRole("dialog", { name: "Artifact details" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    await expect(canvas.getByText("Description for version 2.")).toBeVisible();
  },
};
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Archived", { exact: true })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const popup = within(canvas.getByRole("dialog", { name: "Artifact details" }));
    await expect(popup.getByRole("button", { name: "Restore artifact" })).toBeVisible();
  },
};
export const ArchiveDialog: Story = {
  render: () => (
    <ArtifactArchiveDialog artifactId={artifactFixture.id} onCancel={() => {}} onDone={() => {}} />
  ),
};

export const PreviewSecurityMenu: Story = {
  render: (args) => (
    <ArtifactPreviewSecurityProvider>
      <ArtifactHeader {...args} />
      <ArtifactPreviewSecuritySource
        path="index.html"
        network="blocked"
        verification="ready"
        devices={{ camera: false, microphone: false }}
        capture={{ phase: "idle", camera: false, microphone: false }}
      >
        <p>External connections blocked. No device access.</p>
      </ArtifactPreviewSecuritySource>
    </ArtifactPreviewSecurityProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: /Preview security:/ })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    await userEvent.click(canvas.getByRole("button", { name: /Preview security:/ }));
    await expect(canvas.getByText("External connections blocked. No device access.")).toBeVisible();
  },
};
