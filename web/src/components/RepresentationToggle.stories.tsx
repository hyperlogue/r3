import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { phoneViewport } from "../storyViewport.ts";
import { FileCard } from "./FileCard.tsx";
import { RepresentationToggle } from "./RepresentationToggle.tsx";

const meta = {
  title: "Components/RepresentationToggle",
  component: RepresentationToggle,
  args: { value: "source", onChange: () => {} },
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return (
      <FileCard
        path="index.md"
        viewed={false}
        onToggleViewed={() => {}}
        onFileFeedback={() => {}}
        stats={<RepresentationToggle value={value} onChange={setValue} />}
      >
        <p className="p-3 text-sm">Published {value} content</p>
      </FileCard>
    );
  },
} satisfies Meta<typeof RepresentationToggle>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FileHeader: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Rendered" }));
    await expect(canvas.getByRole("button", { name: "Rendered" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByText("index.md")).toBeVisible();
  },
};
export const Phone: Story = { ...FileHeader, parameters: phoneViewport() };
export const Dark: Story = { ...FileHeader, globals: { theme: "dark" } };
