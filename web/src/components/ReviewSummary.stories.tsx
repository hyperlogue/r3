import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { ReviewSummary } from "./ReviewSummary.tsx";

const SHORT =
  "Reworks the daemon's worktree resolution so a moved clone relinks by name → " +
  "branch instead of a stored path, and surfaces staleness in the review detail.";

// The agent's guide shape: markdown structure (heading, bold, list, inline code)
// plus @path:Lx-y refs that render as clickable jump chips.
const GUIDE =
  "### Where to look\n\n" +
  "The risky part is the **WAL ordering** in @server/db.ts:L10-12 — the pragma " +
  "must run before the first write. The rest is mechanical:\n\n" +
  "- `server/ids.ts` — new id helper, no behavior change\n" +
  "- @web/src/api.ts:L88 — the log pager just gained a cursor\n";

const LONG = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}: this round tightens the anchoring pass so feedback keeps ` +
    "pointing at the right lines after a restructure, re-reading each quote " +
    "whitespace-insensitively and marking the note outdated only when it truly " +
    "can't be found.",
).join("\n\n");

// Multi-screen summary: taller than the 50vh cap, so the expanded body scrolls
// inside its own region instead of pushing the file/feedback split off screen.
const VERY_LONG = Array.from(
  { length: 40 },
  (_, i) =>
    `Paragraph ${i + 1}: this round reworks the daemon's worktree resolution so a ` +
    "moved clone relinks by name → branch instead of a stored path, tightens the " +
    "anchoring pass so feedback keeps pointing at the right lines after a " +
    "restructure, and surfaces staleness in the review detail.",
).join("\n\n");

const meta = {
  title: "Components/ReviewSummary",
  component: ReviewSummary,
  // Sits full-width under the review header — frame it on a page-like surface.
  // Read-only for humans (the summary is set from the CLI), so the story
  // exercises display, collapse, the markdown render (with @ref jump chips),
  // and the select-to-quote bubble.
  decorators: [
    (Story) => (
      <div className="w-[720px] bg-white dark:bg-neutral-950">
        <Story />
      </div>
    ),
  ],
  args: {
    summary: SHORT,
    onJumpRef: fn(),
    onQuote: fn(),
  },
} satisfies Meta<typeof ReviewSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

// The default: a short summary, expanded. The measure is capped (~65ch) for
// readability; selecting text raises the "Quote in note" bubble.
export const WithSummary: Story = {};

// The agent-guide shape: markdown blocks (heading, bold, list, inline code) and
// two @path:Lx-y refs rendered as clickable jump chips (onJumpRef fires; they
// resolve against the live view — the summary pins no version).
export const MarkdownGuide: Story = {
  args: { summary: GUIDE },
};

// A longer, multi-paragraph summary — the capped measure keeps line length
// comfortable even on a wide review pane.
export const LongSummary: Story = {
  args: { summary: LONG },
};

// A multi-screen summary, expanded. The bar is shrink-0 in ReviewView's flex
// column, so without a height bound it would push the file content off screen.
// The 50vh cap + internal scroll keeps the mock content pane below visible and
// reachable while the summary scrolls within its own region. The decorator
// mimics ReviewView's h-full flex column (header · summary · content split).
export const VeryLongSummary: Story = {
  args: { summary: VERY_LONG },
  decorators: [
    (Story) => (
      <div className="flex h-screen flex-col bg-white dark:bg-neutral-950">
        <div className="shrink-0 border-b border-neutral-300 px-3 py-2 text-sm font-medium dark:border-neutral-700">
          Review header
        </div>
        <Story />
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm text-neutral-600 dark:text-neutral-400">
          File content pane — stays visible and scrollable no matter how long the summary is.
        </div>
      </div>
    ),
  ],
};

// No summary set: the component renders nothing (humans can't add one — it's CLI-only).
export const Empty: Story = {
  args: { summary: null },
};

// Collapsed to a one-line preview: the whole bar is the click target, and the
// preview is capped at max-w-prose with the overflow truncated (long summary so
// that's visible). The collapse state persists in localStorage; seed it for this
// story and clean up so the others render expanded.
export const Collapsed: Story = {
  args: { summary: LONG },
  beforeEach: () => {
    localStorage.setItem("r3-summary-collapsed", "1");
    return () => localStorage.removeItem("r3-summary-collapsed");
  },
};
