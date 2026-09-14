import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { artifactFixture } from "../artifact-fixtures.ts";
import type { FeedbackPanelMode } from "../settings.ts";
import { ArtifactFeedbackPanel } from "./ArtifactFeedbackPanel.tsx";
import { ArtifactThreads } from "./ArtifactThreads.tsx";

function Example({ initialMode }: { initialMode: FeedbackPanelMode }) {
  const [mode, setMode] = useState(initialMode);
  return (
    <div className="relative flex h-[700px] border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="min-w-0 flex-1 p-4 text-sm text-neutral-500">
        The floating panel can be moved by its header and resized from any edge or corner. Its
        controls also accept arrow keys.
        {mode === "hidden" && (
          <button type="button" onClick={() => setMode(initialMode)}>
            Show feedback
          </button>
        )}
      </div>
      <ArtifactFeedbackPanel mode={mode} onModeChange={setMode}>
        {(controls) => (
          <ArtifactThreads
            detail={artifactFixture}
            context={{ versionSeq: 1, representation: "source" }}
            onLocate={() => {}}
            onJumpRef={() => {}}
            panelControls={controls}
          />
        )}
      </ArtifactFeedbackPanel>
    </div>
  );
}
const meta = {
  title: "Components/ArtifactFeedbackPanel",
  component: Example,
  args: { initialMode: "floating" },
  parameters: {
    layout: "fullscreen",
    queryData: [[["artifact-watchers", artifactFixture.id], []]],
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Floating: Story = {};
export const FloatingDark: Story = { globals: { theme: "dark" } };
export const Docked: Story = { args: { initialMode: "expanded" } };
export const ModeTransition: Story = {
  ...Docked,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    const draft = canvas.getByRole("textbox", { name: "Feedback" });
    await userEvent.type(draft, "Keep this draft through docking.");
    const panel = canvasElement.querySelector("aside")!;
    const dockedWidth = panel.getBoundingClientRect().width;
    await userEvent.click(canvas.getByRole("button", { name: "Float feedback" }));
    await waitFor(() => expect(panel.getAnimations().length).toBe(0));
    await expect(canvasElement.querySelector("aside")).toBe(panel);
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toBe(draft);
    await userEvent.click(canvas.getByRole("button", { name: "Dock feedback" }));
    await waitFor(() => expect(panel.getAnimations().length).toBe(0));
    await expect(panel.getBoundingClientRect().width).toBe(dockedWidth);
    await expect(draft).toHaveValue("Keep this draft through docking.");
  },
};
export const ModeTransitionDark: Story = { ...ModeTransition, globals: { theme: "dark" } };
export const KeyboardGeometry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = canvas.getByRole("button", { name: "Move feedback" });
    const panel = grip.closest("aside")!;
    const initial = panel.getBoundingClientRect();
    grip.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(panel.getBoundingClientRect().x).toBe(initial.x - 10);
    canvas.getByRole("button", { name: "Resize feedback se" }).focus();
    await userEvent.keyboard("{ArrowUp}");
    await expect(panel.getBoundingClientRect().height).toBe(initial.height - 10);
  },
};
