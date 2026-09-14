import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppHeader } from "./AppHeader.tsx";

const meta = { title: "Components/AppHeader", component: AppHeader } satisfies Meta<
  typeof AppHeader
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ArtifactList: Story = {};
export const WithTitle: Story = {
  args: {
    children: (
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">Published workspace</span>
    ),
  },
};
export const WithTitleDark: Story = { ...WithTitle, globals: { theme: "dark" } };
