import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { JumpToFile, JumpToFileList } from "./JumpToFile.tsx";

const FILES = [
  "server/db.ts",
  "server/index.ts",
  "server/highlight.ts",
  "web/src/api.ts",
  "web/src/components/FileView.tsx",
  "web/src/components/DiffView.tsx",
  "web/src/components/FeedbackPanel.tsx",
  "shared/types.ts",
  "README.md",
];

const meta = {
  title: "Components/JumpToFile",
  component: JumpToFile,
  args: {
    files: FILES,
    viewed: new Set<string>(["server/db.ts", "shared/types.ts"]),
    activePath: "web/src/api.ts",
    onSelect: fn(),
    btnClassName:
      "flex rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
  },
  argTypes: {
    viewed: { control: false },
  },
} satisfies Meta<typeof JumpToFile>;

export default meta;
type Story = StoryObj<typeof meta>;

// The toolbar trigger; click it to open the popover (filter pinned at the
// bottom, Enter jumps to the top match).
export const Default: Story = {};

// The inner list on its own, as the popover/sheet hosts embed it: scrollable
// matches over the bottom-pinned filter input.
export const ListOnly: Story = {
  render: (args) => (
    <div className="flex h-80 w-72 flex-col overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700">
      <JumpToFileList
        files={args.files}
        viewed={args.viewed}
        activePath={args.activePath}
        onSelect={args.onSelect}
      />
    </div>
  ),
};
