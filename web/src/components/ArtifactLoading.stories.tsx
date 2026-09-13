import type { Meta, StoryObj } from "@storybook/react-vite";
import { phoneViewport } from "../storyViewport.ts";
import { ArtifactLoading } from "./ArtifactLoading.tsx";

const meta = {
  title: "Components/ArtifactLoading",
  component: ArtifactLoading,
  args: { label: "Loading preview…" },
} satisfies Meta<typeof ArtifactLoading>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Phone: Story = { parameters: phoneViewport() };
