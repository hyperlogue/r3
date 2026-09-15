import type { Meta, StoryObj } from "@storybook/react-vite";
import { OverlayContrastPreview } from "./OverlayContrastPreview.tsx";

const meta = {
  title: "Showcase/OverlayContrast",
  component: OverlayContrastPreview,
} satisfies Meta<typeof OverlayContrastPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
