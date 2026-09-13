import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { fn } from "storybook/test";
import type { FeedbackPanelMode } from "../settings.ts";
import { FeedbackPanelControls } from "./FeedbackPanelControls.tsx";
import { FeedbackPanelRail } from "./FeedbackPanelRail.tsx";

const meta = {
  title: "Components/FeedbackPanelControls",
  component: FeedbackPanelControls,
  args: { mode: "expanded", onChange: fn() },
  render: function Controls(args) {
    const [mode, setMode] = useState<FeedbackPanelMode>(args.mode);
    const lastOpen = useRef(args.mode);
    return (
      <div className="flex items-center gap-3 p-4">
        <span className="text-sm">{mode}</span>
        {mode === "hidden" ? (
          <div className="relative h-64 w-[32px] border-l border-neutral-300 dark:border-neutral-700">
            <FeedbackPanelRail openCount={3} onShow={() => setMode(lastOpen.current)} />
          </div>
        ) : (
          <FeedbackPanelControls
            mode={mode}
            onChange={(next) => {
              if (next !== "hidden") lastOpen.current = next;
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
export const Expanded: Story = {};
export const Floating: Story = { args: { mode: "floating" } };
