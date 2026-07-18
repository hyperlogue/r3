import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Pill } from "../ui.tsx";
import { FileCard } from "./FileCard.tsx";

const SampleBody = () => (
  <div className="px-3 py-2 font-mono text-xs leading-5 text-neutral-700 dark:text-neutral-300">
    <div>export function open(path: string) {"{"}</div>
    <div>{"  "}const db = new Database(path);</div>
    <div>{"  "}db.exec("PRAGMA journal_mode = WAL;");</div>
    <div>{"  "}return db;</div>
    <div>{"}"}</div>
  </div>
);

const meta = {
  title: "Components/FileCard",
  component: FileCard,
  parameters: { layout: "padded" },
  args: {
    path: "server/db.ts",
    viewed: false,
    autoFold: false,
    onToggleViewed: fn(),
    // The speech-bubble button between the stats slot and the Viewed toggle —
    // opens the composer anchored to the whole file (no line span).
    onFileFeedback: fn(),
    children: <SampleBody />,
  },
  argTypes: {
    stats: { control: false },
    children: { control: false },
  },
} satisfies Meta<typeof FileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Marking a file viewed folds it (only the sticky header shows).
export const Viewed: Story = {
  args: { viewed: true },
};

// Long files start folded via `autoFold`, but stay expandable.
export const AutoFolded: Story = {
  args: { autoFold: true },
};

// The `stats` slot renders between the filename and the Viewed toggle — here a
// status pill plus +/- line counts, like DiffView passes.
export const WithStats: Story = {
  args: {
    stats: (
      <>
        <Pill className="bg-neutral-200 dark:bg-neutral-800">modified</Pill>
        <span className="text-[0.6875rem] font-semibold text-green-600 dark:text-green-400">
          +2
        </span>
        <span className="text-[0.6875rem] font-semibold text-red-600 dark:text-red-400">−1</span>
      </>
    ),
  },
};

// A deep path dims the directory and keeps the basename emphasised.
export const NestedPath: Story = {
  args: { path: "web/src/components/feedback/FeedbackPanel.tsx" },
};

// The card at phone width: the h-8 sticky header stays h-8 (a decided design), the
// deep path truncates to fit, and the header controls keep their hit areas (the
// whole-file feedback button widens into the header padding on coarse pointers).
// Sized to a 390px phone so the sub-md layout is what renders.
export const Mobile: Story = {
  args: { path: "web/src/components/feedback/FeedbackPanel.tsx" },
  parameters: {
    viewport: {
      viewports: { phone: { name: "Phone", styles: { width: "390px", height: "780px" } } },
      defaultViewport: "phone",
    },
  },
};
