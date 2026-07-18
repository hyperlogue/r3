import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { useState } from "react";
import { phoneViewport } from "../storyViewport.ts";
import type { SnapshotMeta, SnapshotRef } from "../types.ts";
import { SnapshotSelect } from "./SnapshotSelect.tsx";

const ISO = "2026-07-05T12:00:00.000Z";
const snapshots: SnapshotMeta[] = [
  { seq: 1, label: "before feedback", created_at: ISO, files: ["doc/notes.md"] },
  { seq: 2, label: "round 2", created_at: ISO, files: ["doc/notes.md", "README.md"] },
  { seq: 3, label: null, created_at: ISO, files: ["doc/notes.md"] },
];

const meta = {
  title: "Components/SnapshotSelect",
  component: SnapshotSelect,
  args: {
    snapshots,
    from: null,
    to: "WORKING",
    onFromChange: fn(),
    onToChange: fn(),
  },
  // Docked in the pane toolbar's flush-right slot in the app; mirror that framing
  // here so the full-height left dividers + dropdown alignment read the same.
  decorators: [
    (Story) => (
      <div className="flex shrink-0 items-center border-b border-neutral-300 bg-white px-1.5 py-0.5 dark:border-neutral-700 dark:bg-neutral-950">
        <div className="-my-0.5 -mr-1.5 ml-auto flex items-stretch self-stretch">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SnapshotSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default: from=None, to=Current — the plain live files view. Open the dropdown
// and use a row's from/to chips (or click a row body to set `to`) to pick a range.
export const Default: Story = {};

// A picked range: from=v1, to=Current — "what changed since snapshot 1". The
// trigger shows "v1 → Current".
export const Range: Story = {
  args: { from: 1, to: "WORKING" },
};

// Interactive: the selection is wired to state as ReviewView does, so the trigger
// label and the row chips update live as you pick from/to.
export const Interactive: Story = {
  render: (args) => {
    const [from, setFrom] = useState<number | null>(1);
    const [to, setTo] = useState<SnapshotRef>(3);
    return (
      <SnapshotSelect {...args} from={from} to={to} onFromChange={setFrom} onToChange={setTo} />
    );
  },
};

// A single snapshot: from can only be None or v1; to is Current or v1.
export const OneSnapshot: Story = {
  args: { snapshots: snapshots.slice(0, 1) },
};

// A label long enough to overflow: min-w-0 down the wrapper→trigger chain lets
// the version label truncate instead of propagating its min-content width and
// overflowing the toolbar row (the desktop trigger caps at max-w-[16rem]).
export const LongLabel: Story = {
  args: {
    snapshots: [
      ...snapshots.slice(0, 2),
      {
        seq: 3,
        label: "after reworking the anchoring section per round-2 feedback",
        created_at: ISO,
        files: ["doc/notes.md"],
      },
    ],
    from: 3,
    to: "WORKING",
  },
};

// The phone tier: below md the trigger becomes the toolbar's full-width first
// row (max-md:flex-1, no width cap, no left divider) and the long label
// truncates inside it instead of overflowing the viewport.
export const Mobile: Story = {
  args: LongLabel.args,
  parameters: phoneViewport(),
};
