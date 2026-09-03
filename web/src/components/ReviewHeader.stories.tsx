import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { phoneViewport } from "../storyViewport.ts";
import type { ReviewDetail } from "../types.ts";
import {
  allSentDetail,
  resolvedUnsentDetail,
  reviewDetail,
  reviews,
  workingDetail,
} from "./_fixtures.ts";
import { ReviewHeader } from "./ReviewHeader.tsx";

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
// targets, branch, session). The fixture holds feedback the agent hasn't been
// handed, so Approve is disabled with the "Submit your feedback first" tooltip.
export const Default: Story = {};

// A review made by an agent: `r3 create` stamps the harness's own session id into
// meta.session when the caller names none, so the line's last token is a UUID. It
// renders as its first group — a full one is the first thing this truncating line
// would clip — and the copy carries the whole id.
export const StampedSession: Story = {
  args: {
    detail: {
      ...reviewDetail,
      meta: { ...reviewDetail.meta, session: "8f14b2c0-5d3e-4a71-9c62-1b0ae7d4f930" },
    },
  },
};

// Everything delivered and nothing claimed: Approve enables even though open
// items remain — an undecided note you chose not to chase doesn't block the
// terminal action. Click it for the confirm dialog (optional next-steps note).
export const Approvable: Story = {
  args: { detail: allSentDetail },
};

// A resolved item's status flip hasn't been handed over yet. Submit is live in
// the panel, but Approve stays enabled — a decision you already made isn't
// content approving would drop unread.
export const ResolvedUnsent: Story = {
  args: { detail: resolvedUnsentDetail },
};

// An agent holds a live claim on one item: Approve goes back to disabled ("still
// working on 1 item") until it replies or the lease expires.
export const AgentWorking: Story = {
  args: { detail: workingDetail },
};

// A closed review: the primary action flips to Reopen and the ⋯ menu drops
// Abandon (only Delete remains).
export const Approved: Story = {
  args: { detail: { ...allSentDetail, status: "approved" } },
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
