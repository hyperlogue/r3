import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { phoneViewport } from "../storyViewport.ts";
import type { ReviewDetail } from "../types.ts";
import { reviewDetail, reviews } from "./_fixtures.ts";
import { ReviewHeader } from "./ReviewHeader.tsx";

// Approve is gated on the *human's* open feedback; flip everything resolved to
// show the enabled terminal action.
const allResolved: ReviewDetail = {
  ...reviewDetail,
  feedback: reviewDetail.feedback.map((f) => ({ ...f, status: "resolved" as const })),
};

// An untitled files review: the source label stands in for the title, and the
// metadata line shows the label instead of a base..head commit range.
const filesDetail: ReviewDetail = { ...reviewDetail, ...reviews[1] };

const meta = {
  title: "Components/ReviewHeader",
  component: ReviewHeader,
  args: {
    detail: reviewDetail,
    onSaveTitle: fn(),
    onSetStatus: fn(),
    onApprove: fn(),
    onDelete: fn(),
  },
  argTypes: {
    detail: { control: false },
  },
} satisfies Meta<typeof ReviewHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

// An open diff review: status pill, editable title (hover pencil), and the
// copyable metadata line (repo → worktree path, base..head split into three copy
// targets, branch, session). The fixture still has open human feedback, so
// Approve is disabled with the "resolve your open feedback first" tooltip.
export const Default: Story = {};

// Every human item resolved: Approve enables (it opens the confirm dialog with
// the optional next-steps note — click it to see; onApprove fires on confirm).
export const AllResolved: Story = {
  args: { detail: allResolved },
};

// A closed review: the primary action flips to Reopen and the ⋯ menu drops
// Abandon (only Delete remains).
export const Approved: Story = {
  args: { detail: { ...allResolved, status: "approved" } },
};

// An untitled files review: the title falls back to the source label, and the
// metadata line shows the label (no commit range to copy).
export const FilesReview: Story = {
  args: { detail: filesDetail },
};

// The phone tier: the actions row wraps under the title (max-md:flex-wrap +
// basis-full) instead of crushing it, and the title lifts to 16px against iOS
// zoom-on-focus.
export const Mobile: Story = {
  parameters: phoneViewport(),
};
