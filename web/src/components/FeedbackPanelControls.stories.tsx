import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { FeedbackPanelMode } from "../settings.ts";
import { FeedbackPanelControls } from "./FeedbackPanelControls.tsx";

const meta = {
  title: "Components/FeedbackPanelControls",
  component: FeedbackPanelControls,
  args: { mode: "expanded", onChange: fn() },
  render: function Controls(args) {
    const [mode, setMode] = useState<FeedbackPanelMode>(args.mode);
    return (
      <div className="flex items-center gap-3 p-4">
        <span className="text-sm">{mode}</span>
        {mode === "hidden" ? (
          <button type="button" onClick={() => setMode(args.mode)}>
            Show feedback
          </button>
        ) : (
          <FeedbackPanelControls
            mode={mode}
            onChange={(next) => {
              setMode(next);
              args.onChange(next);
            }}
          />
        )}
      </div>
    );
  },
} satisfies Meta<typeof FeedbackPanelControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Expanded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Float feedback" }));
    await expect(canvas.getByRole("button", { name: "Dock feedback" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Hide feedback" }));
    await expect(canvas.getByRole("button", { name: "Show feedback" })).toBeVisible();
  },
};
export const Floating: Story = { args: { mode: "floating" } };
