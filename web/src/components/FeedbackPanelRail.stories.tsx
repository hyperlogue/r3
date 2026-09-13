import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FeedbackPanelRail } from "./FeedbackPanelRail.tsx";

const meta = {
  title: "Components/FeedbackPanelRail",
  component: FeedbackPanelRail,
  args: { openCount: 3, onShow: fn() },
  decorators: [
    (Story) => (
      <div className="relative ml-auto h-96 w-[32px] border-l border-neutral-300 dark:border-neutral-700">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FeedbackPanelRail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Collapsed: Story = {};
export const PendingWork: Story = { args: { hasDraft: true, pending: true, watching: true } };
export const Dark: Story = { ...PendingWork, globals: { theme: "dark" } };
