import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppHeader } from "./AppHeader.tsx";

const meta = { title: "Components/AppHeader", component: AppHeader } satisfies Meta<
  typeof AppHeader
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ArtifactList: Story = {};
