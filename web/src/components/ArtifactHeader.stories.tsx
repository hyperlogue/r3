import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { artifactApi } from "../artifact-api.ts";
import { artifactFixture, artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { phoneViewport } from "../storyViewport.ts";
import { ArtifactArchiveDialog, ArtifactHeader } from "./ArtifactHeader.tsx";
import { ArtifactPreviewNetworkControl } from "./ArtifactPreviewNetworkControl.tsx";
import {
  ArtifactPreviewSecurityProvider,
  ArtifactPreviewSecuritySource,
} from "./ArtifactPreviewSecurity.tsx";
import { ShortcutsOverlay } from "./ShortcutsOverlay.tsx";

const meta = {
  title: "Components/ArtifactHeader",
  component: ArtifactHeader,
  args: { detail: artifactFixture },
  parameters: { queryData: [[["artifact-watchers", artifactFixture.id], []]] },
} satisfies Meta<typeof ArtifactHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
function resetHandoffReceipt() {
  localStorage.removeItem("r3-feedback-notifications");
  window.dispatchEvent(
    new StorageEvent("storage", { key: "r3-feedback-notifications", newValue: null }),
  );
}
export const Active: Story = {};
export const EditTitle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: /^Edit title:/ })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const menu = within(canvas.getByRole("dialog", { name: "Artifact details" }));
    await userEvent.click(menu.getByRole("button", { name: "Edit title" }));
    await expect(menu.getByRole("textbox", { name: "Artifact title" })).toHaveFocus();
    await userEvent.type(menu.getByRole("textbox", { name: "Artifact title" }), " revised");
    await userEvent.keyboard("{Escape}");
    await expect(menu.queryByRole("textbox", { name: "Artifact title" })).toBeNull();
    await expect(menu.getByRole("button", { name: "Edit title" })).toHaveFocus();
  },
};
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
    await expect(canvas.getByRole("button", { name: "Hide feedback" })).toHaveAccessibleDescription(
      /1 unhandled thread/,
    );
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
    await expect(
      getComputedStyle(canvas.getByRole("button", { name: "Exit comment mode" })).backgroundColor,
    ).toBe("rgba(0, 0, 0, 0)");
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    await userEvent.click(canvas.getByText("Details", { exact: true }));
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
    const [selected, setSelected] = useState<number | null>(args.selectedVersion ?? 1);
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
    await expect(nav.getByRole("button", { name: "Published version" })).toHaveTextContent(/^v1$/);
    await userEvent.click(nav.getByRole("button", { name: "Published version" }));
    await expect(canvas.getByRole("listbox", { name: "Published versions" })).not.toHaveTextContent(
      /latest/i,
    );
    await userEvent.click(canvas.getByRole("option", { name: "Version 2 · Iteration 2" }));
    await expect(nav.getByRole("button", { name: "Published version" })).toHaveValue("2");
    await userEvent.click(nav.getByRole("button", { name: "Go to the latest version" }));
    await expect(nav.getByRole("button", { name: "Published version" })).toHaveValue("3");
    await expect(nav.queryByRole("button", { name: "Go to the latest version" })).toBeNull();
    await expect(nav.getByLabelText("Latest version")).toBeVisible();
  },
};
export const DarkVersions: Story = { ...Versions, globals: { theme: "dark" } };
export const Storage: Story = {
  ...Versions,
  args: {
    ...Versions.args,
    detail: {
      ...Versions.args!.detail!,
      storage: { totalBytes: 3_500_000, latestVersionBytes: 1_250_000 },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const popup = within(canvas.getByRole("dialog", { name: "Artifact details" }));
    await expect(popup.getByText("Description · Version 1")).toBeVisible();
    const storage = within(popup.getByRole("region", { name: "Storage used" }));
    await expect(storage.getByText("Latest version · 3")).toBeVisible();
    await expect(storage.getByText("3.5 MB")).toHaveAttribute("title", "3,500,000 bytes");
    await expect(storage.getByText("1.3 MB")).toHaveAttribute("title", "1,250,000 bytes");
  },
};
export const StorageDark: Story = { ...Storage, globals: { theme: "dark" } };
export const PhoneStorage: Story = { ...Storage, parameters: phoneViewport() };
export const UnpublishedStorage: Story = {
  args: {
    detail: {
      ...artifactFixture,
      versions: [],
      storage: { totalBytes: 0, latestVersionBytes: 0 },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const storage = within(canvas.getByRole("region", { name: "Storage used" }));
    await expect(storage.getByText("0 B")).toBeVisible();
    await expect(storage.queryByText(/Latest version/)).toBeNull();
  },
};
export const NavbarActions: Story = {
  parameters: { layout: "fullscreen" },
  args: { ...Versions.args, detail: { ...Versions.args!.detail!, kind: "html" } },
  render: (args) => {
    const [selected, setSelected] = useState<number | null>(args.selectedVersion ?? 1);
    const [commenting, setCommenting] = useState(false);
    const [feedbackVisible, setFeedbackVisible] = useState(true);
    return (
      <ArtifactHeader
        {...args}
        selectedVersion={selected}
        onSelectVersion={setSelected}
        commenting={commenting}
        onToggleCommenting={() => setCommenting(!commenting)}
        feedbackVisible={feedbackVisible}
        onToggleFeedback={() => setFeedbackVisible(!feedbackVisible)}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = canvas.getByRole("button", { name: "Artifact details and actions" });
    const commenting = canvas.getByRole("button", { name: "Comment mode" });
    const feedback = canvas.getByRole("button", { name: "Hide feedback" });
    await expect(feedback.getBoundingClientRect().right).toBeLessThan(
      commenting.getBoundingClientRect().left,
    );
    for (const button of [commenting, feedback]) {
      await expect(button.getBoundingClientRect().width).toBe(menu.getBoundingClientRect().width);
      await expect(button.getBoundingClientRect().height).toBe(menu.getBoundingClientRect().height);
    }
    await userEvent.click(commenting);
    await expect(commenting).toHaveAttribute("aria-pressed", "true");
    await expect(commenting.getBoundingClientRect().width).toBe(menu.getBoundingClientRect().width);
  },
};
export const NavbarActionsDark: Story = { ...NavbarActions, globals: { theme: "dark" } };
export const LatestVersion: Story = {
  ...NavbarActions,
  parameters: {
    ...NavbarActions.parameters,
    docs: {
      description: {
        story:
          "The title and borderless version picker form one group, followed by the outlined latest badge.",
      },
    },
  },
  args: { ...NavbarActions.args, selectedVersion: 3 },
};
export const LatestVersionDark: Story = { ...LatestVersion, globals: { theme: "dark" } };
export const PendingSend: Story = {
  ...NavbarActions,
  args: {
    ...NavbarActions.args,
    selectedVersion: 3,
    detail: {
      ...NavbarActions.args!.detail!,
      feedback: [{ ...artifactFixtureFeedback, sentAt: null, replies: [] }],
    },
  },
  parameters: {
    queryData: [
      [
        ["artifact-watchers", artifactFixture.id],
        [{ actor: { role: "agent", sessionId: "review-agent" } }],
      ],
    ],
  },
  beforeEach: resetHandoffReceipt,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const send = canvas.getByRole("button", { name: "Send to agent · 1" });
    await waitFor(() => expect(send).toBeEnabled());
    await expect(send.getBoundingClientRect().right).toBeLessThan(
      canvas.getByRole("button", { name: "Hide feedback" }).getBoundingClientRect().left,
    );
    await expect(canvasElement.querySelector("[data-feedback-attention]")).toBeNull();
  },
};
export const PendingSendDark: Story = { ...PendingSend, globals: { theme: "dark" } };
export const UnsentReply: Story = {
  ...PendingSend,
  args: {
    ...PendingSend.args,
    detail: {
      ...PendingSend.args!.detail!,
      feedback: [
        {
          ...artifactFixtureFeedback,
          replies: [
            ...artifactFixtureFeedback.replies,
            {
              ...artifactFixtureFeedback.replies[0],
              id: "reply_human",
              author: { role: "human", sessionId: null },
              body: "Please include the comparison in the next version.",
              sentAt: null,
            },
          ],
        },
      ],
    },
  },
};
export const SendSuccess: Story = {
  ...PendingSend,
  beforeEach: () => {
    resetHandoffReceipt();
    const original = artifactApi.submit;
    artifactApi.submit = async () => ({ notification: { state: "sent" } });
    return () => {
      artifactApi.submit = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const send = canvas.getByRole("button", { name: "Send to agent · 1" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await expect(await canvas.findByRole("button", { name: "Sent" })).toBeDisabled();
  },
};
export const SendFailure: Story = {
  ...SendSuccess,
  beforeEach: () => {
    resetHandoffReceipt();
    const original = artifactApi.submit;
    artifactApi.submit = async () => {
      throw new Error("The agent could not be reached. Try again.");
    };
    return () => {
      artifactApi.submit = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const send = canvas.getByRole("button", { name: "Send to agent · 1" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The agent could not be reached",
    );
    await expect(send).toBeEnabled();
  },
};
export const LongTitlePendingSend: Story = {
  ...PendingSend,
  args: {
    ...PendingSend.args,
    selectedVersion: 1,
    detail: {
      ...PendingSend.args!.detail!,
      title: "A long artifact title with a pending batch of feedback for the agent",
    },
  },
};
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
    await userEvent.click(popup.getByRole("button", { name: "Go to the latest version" }));
    await expect(canvas.queryByRole("dialog", { name: "Artifact details" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    await expect(canvas.getByText("Description for version 3.")).toBeVisible();
    await expect(popup.queryByRole("button", { name: "Go to the latest version" })).toBeNull();
  },
};
export const NestedKeyboardDismiss: Story = {
  ...PhoneVersions,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Artifact details and actions" });
    await userEvent.click(trigger);
    const picker = canvas.getByRole("button", { name: "Published version" });
    await userEvent.click(picker);
    await userEvent.keyboard("{Escape}");
    await expect(canvas.getByRole("dialog", { name: "Artifact details" })).toBeVisible();
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(picker).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog", { name: "Artifact details" })).toBeNull();
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(canvas.getByRole("button", { name: "Published version" }));
    await userEvent.click(canvas.getByRole("button", { name: "Close artifact details" }));
    await userEvent.click(trigger);
    await expect(canvas.getByRole("button", { name: "Published version" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog", { name: "Artifact details" })).toBeNull();
  },
};
export const LongTitle: Story = {
  ...LatestVersion,
  args: {
    ...LatestVersion.args,
    detail: {
      ...LatestVersion.args!.detail!,
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
      <ShortcutsOverlay />
      <ArtifactPreviewSecuritySource
        path="index.html"
        network="blocked"
        verification="ready"
        devices={{ camera: false, microphone: false }}
        capture={{ phase: "idle", camera: false, microphone: false }}
      >
        <p>External connections blocked. No device access.</p>
        <ArtifactPreviewNetworkControl
          html
          network="blocked"
          verification="ready"
          devices={{ camera: false, microphone: false }}
          capture={{ phase: "idle", camera: false, microphone: false }}
          compatibilityAccepted={false}
          onForgetCompatibility={() => {}}
          onStopSharing={() => {}}
          onChange={() => {}}
        />
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

export const PhonePreviewSecurity: Story = {
  ...PreviewSecurityMenu,
  parameters: phoneViewport(),
};

export const ConsentKeyboardDismiss: Story = {
  ...PreviewSecurityMenu,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Artifact details and actions" }));
    const security = canvas.getByRole("button", { name: /Preview security:/ });
    await userEvent.click(security);
    await expect(canvas.getAllByText("Preview security", { exact: true })).toHaveLength(1);
    const allow = canvas.getByRole("button", { name: "Allow external access" });
    allow.focus();
    await userEvent.keyboard("?");
    await expect(canvas.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    await expect(security).toHaveAttribute("aria-expanded", "true");
    await expect(allow).toHaveFocus();
    await userEvent.click(allow);
    // Browser acceptance covers native Escape; userEvent must dispatch cancel
    // explicitly because a synthetic key cannot trigger the UA dialog action.
    await userEvent.keyboard("{Escape}");
    canvasElement.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await expect(canvas.getByRole("dialog", { name: "Artifact details" })).toBeVisible();
    await expect(security).toHaveAttribute("aria-expanded", "true");
    await expect(allow).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(security).toHaveAttribute("aria-expanded", "false");
    await expect(security).toHaveFocus();
  },
};

export const SettingsFromMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByTitle("Settings")).toBeNull();
    const menu = canvas.getByRole("button", { name: "Artifact details and actions" });
    await userEvent.click(menu);
    await userEvent.click(canvas.getByRole("button", { name: "Settings" }));
    await expect(canvas.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "☀ Light" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog", { name: "Settings" })).toBeNull();
    await expect(menu).toHaveFocus();
  },
};
export const SettingsFromMenuDark: Story = { ...SettingsFromMenu, globals: { theme: "dark" } };
