import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { FeedbackPanelControls } from "./FeedbackPanelControls.tsx";

const meta = {
  title: "Components/FeedbackPanelControls",
  component: FeedbackPanelControls,
  args: { mode: "expanded", onChange: fn() },
  render: function Controls(args) {
    const [mode, setMode] = useState(args.mode);
    return (
      <div className="flex items-center gap-3 p-4">
        <span className="text-sm">{mode}</span>
        <FeedbackPanelControls
          mode={mode}
          onChange={(next) => {
            setMode(next);
            args.onChange(next);
          }}
        />
      </div>
    );
  },
} satisfies Meta<typeof FeedbackPanelControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Expanded: Story = {};
export const Floating: Story = { args: { mode: "floating" } };
export const Hidden: Story = { args: { mode: "hidden" } };
