import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { fn } from "storybook/test";
import { clearDraft, setReplyText } from "../drafts.ts";
import type { FeedbackWithReplies } from "../types.ts";
import { reviewDetail, workingDetail } from "./_fixtures.ts";
import { FeedbackCard } from "./FeedbackCard.tsx";

// One card per state, so a change to the header, the thread fold, the action row
// or the claim badge is visible on its own rather than only in the panel's list.
const byId = (id: string): FeedbackWithReplies => {
  const fb = reviewDetail.feedback.find((f) => f.id === id);
  if (!fb) throw new Error(`no fixture feedback ${id}`);
  return fb;
};

// The reply composer owns its text through the browser draft store (drafts.ts),
// same as the panel's composers — seed it to show the box holding a draft, and
// clear it on unmount so it can't leak into the next story. Seeded in a lazy
// state initializer, not an effect: the card reads the draft ONCE, in its own
// `replyOpen` initializer, so a seed that lands after mount would never open the
// composer. This runs while the decorator renders, before the card mounts.
const withReplyDraft = (id: string, text: string): Decorator => {
  return (Story) => {
    useState(() => setReplyText(reviewDetail.id, id, text));
    useEffect(() => () => clearDraft(reviewDetail.id), []);
    return <Story />;
  };
};

const meta = {
  title: "Components/FeedbackCard",
  component: FeedbackCard,
  // A card is a full-width row of the docked panel; frame it at the panel's width.
  decorators: [
    (Story) => (
      <div className="w-[440px] overflow-hidden rounded-lg border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
        <Story />
      </div>
    ),
  ],
  args: {
    fb: byId("feedback_pragma"),
    reviewId: reviewDetail.id,
    onLocate: fn(),
    onFocus: fn(),
    onLocatePin: fn(),
    onResolved: fn(),
    onReplied: fn(),
    onJumpRef: fn(),
    isActive: false,
    command: null,
    error: null,
    reportError: fn(),
  },
  argTypes: {
    fb: { control: false },
    command: { control: false },
  },
} satisfies Meta<typeof FeedbackCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// The steady state: a human note anchored to a line range, its quote above the
// body, the Resolve · ⋯ · Reply row below. The body's `@server/db.ts:L11-12` ref
// renders as a click-to-scroll link.
export const Default: Story = {};

// Active: the amber left rail and faint wash the panel gives the focused card.
export const Active: Story = { args: { isActive: true } };

// The anchor drifted — the quote couldn't be relocated after the file changed, so
// the header wears the amber ⚠ and the note says what it used to point at. Its one
// reply is pinned to round 2 ("↳ addressed in diff 2"), the agent's way of saying
// where the fix landed.
export const Outdated: Story = { args: { fb: byId("feedback_outdated") } };

// A long thread: earlier turns fold away behind a count, leaving the last few.
// Agent replies take the soft blue bubble; human replies render as plain prose.
export const LongThread: Story = { args: { fb: byId("feedback_thread") } };

// Agent-authored (`r3 feedback add`): the "agent" chip in the header, and the body
// in the same blue bubble an agent reply wears — one voice, one surface.
export const AgentAuthored: Story = { args: { fb: byId("feedback_agent_note") } };

// Resolved is loud, not merely filtered: a success wash, a ✓ resolved pill, and a
// Reopen that fades back — reopening is the exception, not the next step.
export const Resolved: Story = { args: { fb: byId("feedback_resolved") } };

// Whole-file anchor (the file header's feedback button): a real path, no line span
// and no quote, so the header names the file alone.
export const WholeFile: Story = { args: { fb: byId("feedback_whole_file") } };

// Anchored into the review's own summary prose rather than a file — the header
// reads "review summary".
export const SummaryAnchor: Story = { args: { fb: byId("feedback_review_summary") } };

// An agent holds a live claim on this item: the working badge names the session
// (click-to-copy) over the card-wide dimming that ranks claimed work below the
// rest of the active list.
export const Claimed: Story = { args: { fb: workingDetail.feedback[0] } };

// The reply composer open with a persisted draft in it — what returning to a
// half-written reply looks like.
export const ReplyDraft: Story = {
  args: { fb: byId("feedback_pragma"), isActive: true },
  decorators: [withReplyDraft("feedback_pragma", "Moved it above the first write — see round 3.")],
};

// A failed mutation's only surface: the server's message under the action row,
// with focus handed back to this card.
export const MutationError: Story = {
  args: { error: "no diff 2 in this review (see r3 diff list)", isActive: true },
};
