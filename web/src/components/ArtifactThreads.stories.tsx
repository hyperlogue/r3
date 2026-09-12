import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { artifactFixture, artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { Button } from "../ui.tsx";
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
export const FeedbackTabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("tab", { name: /Active/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(canvas.getByRole("tab", { name: /Resolved/ }));
    await expect(canvas.getByText("No resolved feedback.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toBeVisible();
  },
};
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
