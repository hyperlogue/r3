import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewSwitcher } from "./ReviewSwitcher.tsx";

// Navbar "Reviews" breadcrumb. The stand-in bar mirrors the real navbar (h-8).
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
