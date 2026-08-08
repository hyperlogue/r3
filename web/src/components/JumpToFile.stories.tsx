import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
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
// bottom, arrows to move the cursor, Enter to open it).
export const Default: Story = {};

// The inner list on its own, as the popover/sheet hosts embed it: scrollable
// matches over the bottom-pinned filter input. The cursor starts on the top row
// (primary rail + fill); `web/src/api.ts` below it carries the quieter neutral
// tint that marks the file the PANE is on — the two states are deliberately
// different colours because they're usually different rows.
export const ListOnly: Story = {
  render: (args) => (
    <div className="flex h-80 w-72 flex-col overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700">
      <JumpToFileList
        files={args.files}
        viewed={args.viewed}
        activePath={args.activePath}
        onSelect={args.onSelect}
        autoFocus
      />
    </div>
  ),
};

// Two ↓ presses move the cursor down two rows; Enter opens whatever it's on
// (not the top match). Also covers the Ctrl-p alias walking back up.
export const ArrowsThenEnter: Story = {
  render: ListOnly.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByPlaceholderText("Filter files…"));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Control>}p{/Control}"); // back up one
    await userEvent.keyboard("{Enter}");
    // The two viewed files sink to the bottom, so the rows are index.ts,
    // highlight.ts, api.ts, … — and down-down-up lands on row 1.
    await expect(args.onSelect).toHaveBeenCalledWith("server/highlight.ts");
  },
};

// Typing re-ranks the list under the cursor, so the cursor resets to the top
// match — Enter after a filter picks the first row, as it always did.
export const FilterResetsCursor: Story = {
  render: ListOnly.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Filter files…");
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.type(input, "Diff");
    await userEvent.keyboard("{Enter}");
    await expect(args.onSelect).toHaveBeenCalledWith("web/src/components/DiffView.tsx");
  },
};

// The cursor clamps at the ends rather than wrapping — the same rule every other
// list step in the app follows. More downs than there are rows stop at the last.
export const ClampsAtEnd: Story = {
  render: ListOnly.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByPlaceholderText("Filter files…"));
    await userEvent.keyboard("{ArrowDown}".repeat(FILES.length + 3));
    await userEvent.keyboard("{Enter}");
    // Viewed files sink to the bottom; shared/types.ts is the last of the two.
    await expect(args.onSelect).toHaveBeenCalledWith("shared/types.ts");
  },
};
