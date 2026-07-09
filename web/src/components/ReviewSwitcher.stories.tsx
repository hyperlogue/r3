import type { Meta, StoryObj } from "@storybook/react";
import { ReviewSwitcher } from "./ReviewSwitcher.tsx";

// The always-present "Reviews" breadcrumb; clicking it returns to the home list.
// The stand-in bar mirrors the real navbar (h-8, no vertical padding) so the
// full-height, square hover background reads as a tab. A quick-switch popup panel
// will live here in the future.
const meta = {
  title: "Components/ReviewSwitcher",
  component: ReviewSwitcher,
  decorators: [
    (Story) => (
      <div className="flex h-8 items-center border-b border-neutral-300 bg-white pl-3 dark:border-neutral-700 dark:bg-neutral-950">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReviewSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
