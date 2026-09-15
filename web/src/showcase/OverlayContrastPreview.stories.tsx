import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { OverlayContrastPreview } from "./OverlayContrastPreview.tsx";

const meta = {
  title: "Showcase/OverlayContrast",
  component: OverlayContrastPreview,
} satisfies Meta<typeof OverlayContrastPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const VisibleComparison: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const current = canvas.getByRole("button", { name: "Current" });
    const stronger = canvas.getByRole("button", { name: "Stronger" });
    await userEvent.click(current);
    const sample = canvas.getByRole("region", { name: "Overlay sample" });
    const original = getComputedStyle(sample);
    const border = original.borderBottomColor;
    const shadow = original.boxShadow;
    const height = sample.getBoundingClientRect().height;
    await userEvent.click(stronger);
    await expect(stronger).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(getComputedStyle(sample).borderBottomColor).not.toBe(border);
      expect(getComputedStyle(sample).boxShadow).not.toBe(shadow);
    });
    await expect(sample.getBoundingClientRect().height).toBe(height);
    await userEvent.click(current);
    await expect(current).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(getComputedStyle(sample).borderBottomColor).toBe(border);
      expect(getComputedStyle(sample).boxShadow).toBe(shadow);
    });
  },
};
export const DarkComparison: Story = { ...VisibleComparison, globals: { theme: "dark" } };
