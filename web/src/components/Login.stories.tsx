import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "@storybook/test";
import { Login } from "./Login.tsx";

// The remote-access login screen. Rendered by main.tsx when GET /api/boot reports
// `needsAuth` (an exposed daemon with no valid session).
const meta = {
  title: "Components/Login",
  component: Login,
  parameters: { layout: "fullscreen" },
  // Login fills its parent (`h-full`); give it a definite height in the workshop.
  decorators: [
    (Story) => (
      <div className="h-[34rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Login>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Typing a token enables the Sign in button (we stop short of submitting — that
// would hit the network + reload).
export const Typed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("r3tok_…"), "r3tok_deadbeef");
    await expect(canvas.getByRole("button", { name: "Sign in" })).toBeEnabled();
  },
};
