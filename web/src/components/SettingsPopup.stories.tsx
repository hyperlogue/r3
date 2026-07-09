import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "@storybook/test";
import { themeOptions } from "./_fixtures.ts";
import { SettingsPopup } from "./SettingsPopup.tsx";

const meta = {
  title: "Components/SettingsPopup",
  component: SettingsPopup,
  // The gear is meant to sit in the header's top-right; anchor it there so the
  // popup opens in view.
  decorators: [
    (Story) => (
      <div className="flex justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
    // GET /api/themes — seeded so the syntax-theme dropdown shows grouped options.
    queryData: [[["themes"], themeOptions]],
  },
} satisfies Meta<typeof SettingsPopup>;

export default meta;
type Story = StoryObj<typeof meta>;

// Just the gear button (popup closed).
export const Closed: Story = {};

// Opened via the gear: appearance toggle, font-size slider, syntax-theme picker.
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTitle("Settings"));
    await expect(canvas.getByText("Appearance")).toBeInTheDocument();
  },
};
