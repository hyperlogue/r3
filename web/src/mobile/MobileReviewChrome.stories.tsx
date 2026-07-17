import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { useState } from "react";
import { MobileReviewChrome, type MobileSheetState } from "./MobileReviewChrome.tsx";

// A stand-in for the FeedbackPanel the sheet hosts in the app (the real panel
// needs a live review). Fills the sheet like the panel does (h-full flex-col).
function PanelStandIn() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-neutral-400">
      <span className="font-semibold text-neutral-500">FeedbackPanel renders here</span>
      <span>same instance, same props as the desktop dock</span>
    </div>
  );
}

const meta = {
  title: "Mobile/MobileReviewChrome",
  component: MobileReviewChrome,
  // The chrome is phone furniture: frame it narrow. The sheet is fixed to the
  // preview viewport, so it pins to the story canvas bottom — that's the real
  // geometry on a phone.
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[390px] flex-col justify-end border border-dashed border-neutral-300 dark:border-neutral-700">
        <Story />
      </div>
    ),
  ],
  args: {
    openCount: 3,
    watchers: [{ session: "claude-mobile", agentId: "claude-1" }],
    sheet: "closed",
    onSetSheet: fn(),
    children: <PanelStandIn />,
  },
  argTypes: {
    children: { control: false },
  },
} satisfies Meta<typeof MobileReviewChrome>;

export default meta;
type Story = StoryObj<typeof meta>;

// Bar only — the sheet is closed (translated away + inert).
export const Closed: Story = {};

export const NoWatcher: Story = {
  args: { watchers: [], openCount: 0 },
};

// Composer peek: the short sheet leaves the code readable above it.
export const Peek: Story = {
  args: { sheet: "peek" },
};

// Full-height sheet with the dimmed click-away backdrop.
export const Full: Story = {
  args: { sheet: "full" },
};

// The real state machine: tap the bar to open, the handle to shrink/expand,
// ✕ (or the backdrop) to close.
export const Interactive: Story = {
  render: (args) => {
    const [sheet, setSheet] = useState<MobileSheetState>("closed");
    return <MobileReviewChrome {...args} sheet={sheet} onSetSheet={setSheet} />;
  },
};
