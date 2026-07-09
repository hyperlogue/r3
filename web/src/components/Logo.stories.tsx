import type { Meta, StoryObj } from "@storybook/react";
import { useRef } from "react";
import { Logo, type LogoHandle } from "./Logo.tsx";

const meta = {
  title: "Components/Logo",
  component: Logo,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

// Nav-bar size — the mark must still read at 16px.
export const NavBar: Story = { args: { className: "size-4" } };

export const Large: Story = { args: { className: "size-32" } };

// The off-white tile is what keeps the mark legible on dark chrome.
export const OnDark: Story = {
  args: { className: "size-16" },
  decorators: [(Story) => <div className="rounded-xl bg-neutral-900 p-6">{Story()}</div>],
};

// The nav-bar fidget toy: clicking flicks the spikes into a spin (momentum
// stacks on repeated clicks) and they always settle back upright.
function FidgetDemo() {
  const logo = useRef<LogoHandle>(null);
  return (
    <button
      type="button"
      title="click me — keep clicking"
      onClick={() => logo.current?.flick()}
      className="cursor-pointer"
    >
      <Logo ref={logo} className="size-32" />
    </button>
  );
}
export const Fidget: Story = { render: () => <FidgetDemo /> };
