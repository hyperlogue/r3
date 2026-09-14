import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FeedbackMotionProposal, PrimaryColorProposals } from "./DesignProposals.tsx";

const meta = {
  title: "Showcase/DesignProposals",
  component: FeedbackMotionProposal,
} satisfies Meta<typeof FeedbackMotionProposal>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Motion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const draft = canvas.getByRole("textbox", { name: "Sample draft" });
    await userEvent.type(draft, "Keep this draft while switching.");
    await userEvent.click(canvas.getByRole("button", { name: "Float" }));
    await userEvent.click(canvas.getByRole("tab", { name: "Resolved 2" }));
    await expect(canvas.getByRole("tabpanel")).toHaveAccessibleName("Resolved 2");
    await userEvent.keyboard("{ArrowLeft}");
    await expect(canvas.getByRole("tabpanel")).toHaveAccessibleName("Active 2");
    await userEvent.click(canvas.getByRole("button", { name: "Dock" }));
    await expect(draft).toHaveValue("Keep this draft while switching.");
  },
};
export const MotionDark: Story = { ...Motion, globals: { theme: "dark" } };
export const Colors: Story = { render: () => <PrimaryColorProposals /> };
