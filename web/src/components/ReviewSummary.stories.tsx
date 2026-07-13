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
