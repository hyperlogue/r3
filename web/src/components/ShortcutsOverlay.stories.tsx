import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { phoneViewport } from "../storyViewport.ts";
import { ShortcutsOverlay } from "./ShortcutsOverlay.tsx";

const meta = {
  title: "Components/ShortcutsOverlay",
  component: ShortcutsOverlay,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ShortcutsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

// The component renders nothing until `?` is pressed — it owns its own open
// state (and the `help` binding), so there's no prop to open it with. Every story
// below drives it the way a user does.
export const Closed: Story = {};

// The sheet as `?` opens it: four groups rendered straight from KEYMAP, so this
// story is also the check that a newly added binding shows up documented.
export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.keyboard("?");
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("Keyboard shortcuts")).toBeInTheDocument();
    // The alias pair reads as "j or Ctrl-n", never as a two-key sequence.
    await expect(body.getByText("Ctrl-n")).toBeInTheDocument();
  },
};

// `?` toggles: a second press closes the sheet it opened.
export const TogglesClosed: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.keyboard("?");
    await expect(await body.findByText("Keyboard shortcuts")).toBeInTheDocument();
    await userEvent.keyboard("?");
    await expect(body.queryByText("Keyboard shortcuts")).not.toBeInTheDocument();
  },
};

// Phone width: the two columns collapse to one and the sheet scrolls inside its
// own max-height rather than growing past the viewport.
export const Mobile: Story = {
  parameters: phoneViewport(),
  play: async ({ canvasElement }) => {
    await userEvent.keyboard("?");
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("Keyboard shortcuts")).toBeInTheDocument();
  },
};
