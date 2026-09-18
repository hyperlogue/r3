import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { artifactDrafts } from "../artifact-drafts.ts";
import { artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { ArtifactFeedbackToggle } from "./ArtifactFeedbackToggle.tsx";

const meta = {
  title: "Components/ArtifactFeedbackToggle",
  component: ArtifactFeedbackToggle,
  args: {
    artifactId: "artifact_toggle_story",
    feedback: [artifactFixtureFeedback],
    visible: false,
    onToggle: () => {},
  },
} satisfies Meta<typeof ArtifactFeedbackToggle>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unhandled: Story = {
  render: (args) => {
    const [visible, setVisible] = useState(false);
    const [feedback, setFeedback] = useState(args.feedback);
    return (
      <div className="flex items-center gap-4">
        <ArtifactFeedbackToggle
          {...args}
          visible={visible}
          onToggle={() => setVisible(!visible)}
          feedback={feedback}
        />
        <button
          type="button"
          onClick={() => setFeedback(feedback.map((note) => ({ ...note, status: "resolved" })))}
        >
          Resolve thread
        </button>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Show feedback" })).toHaveAccessibleDescription(
      /1 unhandled thread/,
    );
    await expect(canvasElement.querySelector("[data-feedback-attention]")).not.toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Show feedback" }));
    await expect(canvas.getByRole("button", { name: "Hide feedback" })).toHaveAccessibleDescription(
      /1 unhandled thread/,
    );
    await expect(
      getComputedStyle(canvas.getByRole("button", { name: "Hide feedback" })).backgroundColor,
    ).toBe("rgba(0, 0, 0, 0)");
    await userEvent.click(canvas.getByRole("button", { name: "Resolve thread" }));
    await expect(canvas.getByRole("button", { name: "Hide feedback" })).toHaveAccessibleDescription(
      /0 unhandled threads/,
    );
    await expect(canvasElement.querySelector("[data-feedback-attention]")).toBeNull();
  },
};
export const UnhandledDark: Story = { ...Unhandled, globals: { theme: "dark" } };
export const UnhandledAndUnsent: Story = {
  args: { feedback: [{ ...artifactFixtureFeedback, sentAt: null }] },
};
export const UnhandledAndUnsentDark: Story = {
  ...UnhandledAndUnsent,
  globals: { theme: "dark" },
};
export const UnsentOnly: Story = {
  args: { feedback: [{ ...artifactFixtureFeedback, replies: [], sentAt: null }] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-feedback-attention]")).toBeNull();
  },
};
export const DraftOnly: Story = {
  args: { artifactId: "artifact_toggle_draft_story", feedback: [] },
  beforeEach: () => {
    artifactDrafts.update("artifact_toggle_draft_story", { body: "A note in progress" });
    return () => artifactDrafts.clear("artifact_toggle_draft_story");
  },
  play: UnsentOnly.play,
};
export const Handled: Story = {
  args: { feedback: [{ ...artifactFixtureFeedback, replies: [] }] },
};
