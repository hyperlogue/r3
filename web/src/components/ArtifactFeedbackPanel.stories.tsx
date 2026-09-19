import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { artifactDrafts } from "../artifact-drafts.ts";
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
        <button type="button" onClick={() => setMode(mode === "hidden" ? initialMode : "hidden")}>
          Toggle feedback externally
        </button>
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
export const FloatingHide: Story = {
  beforeEach: () => {
    artifactDrafts.clear(artifactFixture.id);
    localStorage.setItem(
      "r3-feedback-floating-rect",
      JSON.stringify({ x: 130, y: 100, width: 420, height: 440 }),
    );
    return () => {
      artifactDrafts.clear(artifactFixture.id);
      localStorage.removeItem("r3-feedback-floating-rect");
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvasElement.querySelector("aside")!;
    const content = panel.previousElementSibling!;
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    const draft = canvas.getByRole("textbox", { name: "Feedback" });
    await userEvent.type(draft, "Keep this draft while hidden.");
    for (const control of ["Hide feedback", "Toggle feedback externally"]) {
      const before = panel.getBoundingClientRect();
      const contentWidth = content.getBoundingClientRect().width;
      fireEvent.click(canvas.getByRole("button", { name: control }));
      const animations = panel.getAnimations();
      await expect(animations.length).toBeGreaterThan(0);
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
      }
      const during = panel.getBoundingClientRect();
      await expect(during.x).toBeCloseTo(before.x, 0);
      await expect(during.y).toBeCloseTo(before.y, 0);
      await expect(during.width).toBeCloseTo(before.width, 0);
      await expect(during.height).toBeCloseTo(before.height, 0);
      await expect(content.getBoundingClientRect().width).toBe(contentWidth);
      await expect(panel).toHaveAttribute("inert");
      await expect(Number(getComputedStyle(panel).opacity)).toBeGreaterThan(0);
      await expect(Number(getComputedStyle(panel).opacity)).toBeLessThan(1);
      await expect(getComputedStyle(draft).visibility).toBe("visible");
      for (const animation of animations) animation.finish();
      await waitFor(() => expect(panel.getAnimations().length).toBe(0));
      await expect(Number(getComputedStyle(panel).opacity)).toBe(0);
      await userEvent.click(canvas.getByRole("button", { name: "Show feedback" }));
      await waitFor(() => expect(panel.getAnimations().length).toBe(0));
      await expect(panel).not.toHaveAttribute("inert");
      await expect(canvas.getByRole("textbox", { name: "Feedback" })).toBe(draft);
      await expect(draft).toHaveValue("Keep this draft while hidden.");
    }
  },
};
export const FloatingHideDark: Story = { ...FloatingHide, globals: { theme: "dark" } };
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
