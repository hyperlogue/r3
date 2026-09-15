import type { Meta, StoryObj } from "@storybook/react-vite";
import { TutorialGuide } from "./Tutorial.tsx";

const meta = {
  title: "Tutorial/Guide",
  component: TutorialGuide,
  args: { step: 1, done: [true, false, false, false, false, false], onStep: () => {} },
} satisfies Meta<typeof TutorialGuide>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AnchorFeedback: Story = {};
export const Complete: Story = { args: { step: 5, done: [true, true, true, true, true, true] } };
export const Dark: Story = { globals: { theme: "dark" } };
