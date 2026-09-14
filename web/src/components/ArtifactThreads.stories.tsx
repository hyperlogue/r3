import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { artifactApi } from "../artifact-api.ts";
import { artifactFixture, artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { Button } from "../ui.tsx";
import { ArtifactThreads } from "./ArtifactThreads.tsx";
import { FeedbackPanelControls } from "./FeedbackPanelControls.tsx";

const meta = {
  title: "Components/ArtifactThreads",
  component: ArtifactThreads,
  args: {
    detail: artifactFixture,
    context: { versionSeq: 1, representation: "source" },
    onLocate: fn(),
    onJumpRef: fn(),
    panelControls: <FeedbackPanelControls mode="expanded" onChange={fn()} />,
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
export const MenuKeyboardDismiss: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "More actions" });
    await userEvent.click(trigger);
    await expect(canvas.getByRole("button", { name: "Delete" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog", { name: "Feedback actions" })).toBeNull();
    await expect(trigger).toHaveFocus();
  },
};
export const Dark: Story = { globals: { theme: "dark" } };
export const ResolveHovered: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole("button", { name: "✓ Resolve" }));
  },
};
export const ResolveHoveredDark: Story = { ...ResolveHovered, globals: { theme: "dark" } };
export const ResolveIdle: Story = {};
export const ResolveIdleDark: Story = { globals: { theme: "dark" } };
export const ResolvePending: Story = {
  beforeEach: () => {
    const original = artifactApi.editFeedback;
    artifactApi.editFeedback = () => new Promise(() => {});
    return () => {
      artifactApi.editFeedback = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "✓ Resolve" }));
    await expect(canvas.getByRole("tab", { name: "Active 0" })).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Resolved 1" }));
    await expect(canvas.getByRole("button", { name: "Reopen" })).toBeDisabled();
  },
};
export const ResolveFailed: Story = {
  beforeEach: () => {
    const original = artifactApi.editFeedback;
    artifactApi.editFeedback = async () => {
      throw new Error("Could not save this decision. Try again.");
    };
    return () => {
      artifactApi.editFeedback = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "✓ Resolve" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Could not save this decision",
    );
    await expect(canvas.getByRole("tab", { name: "Active 1" })).toBeVisible();
  },
};
export const NarrowPanel: Story = {
  decorators: [
    (Story) => (
      <div className="h-full w-[300px]">
        <Story />
      </div>
    ),
  ],
};
export const FeedbackTabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("tab", { name: /Active/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(canvas.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(canvas.getByText("No resolved feedback.")).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: /Active/ }));
    const composer = canvasElement.querySelector("[data-artifact-composer]");
    const list = canvasElement.querySelector("[data-feedback-list]");
    await expect(
      composer && list?.querySelector(":scope > :not([inert])")?.contains(composer),
    ).toBeTruthy();
  },
};
export const ComposerAsCard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    const input = canvas.getByRole("textbox", { name: "Feedback" });
    await expect(input.closest("[data-feedback-list]")).not.toBeNull();
    await userEvent.type(input, "This draft is a pending feedback card.");
    await expect(canvas.queryByText("Post or discard drafts before sending feedback")).toBeNull();
  },
};
export const ComposerAsCardDark: Story = { ...ComposerAsCard, globals: { theme: "dark" } };
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

export const CardMotion: Story = {
  render: (args) => {
    const [feedback, setFeedback] = useState(() =>
      [1, 2, 3].map((number) => ({
        ...artifactFixtureFeedback,
        id: `motion_${number}`,
        body: `Sample thread ${number}`,
        replies: [],
      })),
    );
    const [next, setNext] = useState(4);
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap gap-2 border-b border-neutral-300 p-2 dark:border-neutral-700">
          <Button
            onClick={() => {
              setFeedback((current) => [
                ...current,
                {
                  ...artifactFixtureFeedback,
                  id: `motion_${next}`,
                  body: `Sample thread ${next}`,
                  replies: [],
                },
              ]);
              setNext(next + 1);
            }}
          >
            Insert card
          </Button>
          <Button onClick={() => setFeedback((current) => current.slice(1))}>Remove first</Button>
          <Button
            onClick={() =>
              setFeedback((current) =>
                current.length ? [...current.slice(1), current[0]] : current,
              )
            }
          >
            Reorder
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <ArtifactThreads {...args} detail={{ ...args.detail, feedback }} keysActive={false} />
        </div>
      </div>
    );
  },
};

export const PendingHandoff: Story = {
  args: {
    detail: { ...artifactFixture, feedback: [{ ...artifactFixtureFeedback, sentAt: null }] },
  },
  parameters: {
    queryData: [
      [
        ["artifact-watchers", artifactFixture.id],
        [{ actor: { role: "agent", sessionId: "review-agent" } }],
      ],
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not sent", { exact: true })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send to agent · 1" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Feedback" }), "Keep this draft");
    await expect(canvas.getByText("Post or discard drafts before sending feedback")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send to agent · 1" })).toBeDisabled();
  },
};

export const ReopenDuringExit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await Promise.all(
      canvasElement
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(canvasElement.querySelector("[data-feedback-draft][inert]")).not.toBeNull(),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await waitFor(() =>
      expect(
        canvasElement.querySelector("[data-artifact-composer] textarea:not([inert] *)"),
      ).toHaveFocus(),
    );
  },
};
