import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { FileBrowser } from "./FileBrowser.tsx";

const FILES = [
  "server/db.ts",
  "server/index.ts",
  "server/highlight.ts",
  "web/src/api.ts",
  "web/src/components/Sidebar.tsx",
  "web/src/components/FileView.tsx",
  "web/src/components/DiffView.tsx",
  "shared/types.ts",
  "README.md",
];

const meta = {
  title: "Components/FileBrowser",
  component: FileBrowser,
  // The aside is full-height (flex-1 + overflow-y-auto) — give it a frame.
  decorators: [
    (Story) => (
      <div className="flex h-[640px]">
        <Story />
      </div>
    ),
  ],
  args: {
    files: FILES,
    viewed: new Set<string>(["server/db.ts", "shared/types.ts"]),
    activePath: "web/src/components/Sidebar.tsx",
    onSelect: fn(),
  },
  argTypes: {
    viewed: { control: false },
  },
} satisfies Meta<typeof FileBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

// The directory tree, with two files marked viewed and one active.
export const Default: Story = {};

export const NothingViewed: Story = {
  args: { viewed: new Set<string>(), activePath: null },
};

export const AllViewed: Story = {
  args: { viewed: new Set(FILES) },
};

export const SingleFile: Story = {
  args: {
    files: ["web/src/components/FeedbackPanel.tsx"],
    viewed: new Set<string>(),
    activePath: "web/src/components/FeedbackPanel.tsx",
  },
};

// A deep single-child chain collapses into one row: aaa/bbb/ccc holds only
// ddd.ts, so the tree shows "aaa/bbb/ccc/" then the file, not four nested rows.
export const CollapsedChain: Story = {
  args: {
    files: ["aaa/bbb/ccc/ddd.ts", "src/one/deep/nested/only/here.ts", "README.md"],
    viewed: new Set<string>(),
    activePath: "aaa/bbb/ccc/ddd.ts",
  },
};

// Folded to the thin rail (the collapse state persists in localStorage; seed it
// for this story and clean up so the other stories render expanded).
export const Collapsed: Story = {
  beforeEach: () => {
    localStorage.setItem("r3-filebrowser-collapsed", "1");
    return () => localStorage.removeItem("r3-filebrowser-collapsed");
  },
};
