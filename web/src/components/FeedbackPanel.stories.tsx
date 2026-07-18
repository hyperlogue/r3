import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { fn, userEvent, within } from "@storybook/test";
import { useEffect } from "react";
import { clearDraft, setDraftText } from "../drafts.ts";
import { phoneViewport } from "../storyViewport.ts";
import {
  allSentDetail,
  noWatchers,
  pendingAnchor,
  reviewDetail,
  watching,
  wholeFilePendingAnchor,
} from "./_fixtures.ts";
import { FeedbackPanel } from "./FeedbackPanel.tsx";

const WATCHERS_KEY = ["watchers", reviewDetail.id];

// The composers own their text via the browser draft store (drafts.ts), so seed it
// here rather than through a prop; cleaned up on unmount so it can't leak between
// stories. Pair with `pending` to show the anchored composer holding that text.
const withAnchoredDraft = (text: string): Decorator => {
  return (Story) => {
    useEffect(() => {
      setDraftText(reviewDetail.id, text);
      return () => clearDraft(reviewDetail.id);
    }, []);
    return <Story />;
  };
};

const meta = {
  title: "Components/FeedbackPanel",
  component: FeedbackPanel,
  // The panel fills the right-hand column; frame it with a fixed-size border.
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[440px] overflow-hidden rounded-lg border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950">
        <Story />
      </div>
    ),
  ],
  parameters: {
    // GET /api/reviews/:id/watchers — default: nobody watching.
    queryData: [[WATCHERS_KEY, noWatchers]],
  },
  args: {
    detail: reviewDetail,
    pending: null,
    onDiscardPending: fn(),
    onSubmittedPending: fn(),
    activeFeedbackId: null,
    scrollNonce: 0,
    onLocateFeedback: fn(),
    onLocatePin: fn(),
    onJumpRef: fn(),
  },
  argTypes: {
    detail: { control: false },
    pending: { control: false },
  },
} satisfies Meta<typeof FeedbackPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// Active tab, no composer open. Every card shows the steady Resolve · ⋯ · Reply
// action row (the composer stays hidden until "Reply" is clicked). Attention-first
// ordering: the "your turn" cards (agent had the last word) — the outdated one
// (amber ⚠ prefixing the file name) and the agent-authored note (the "agent"
// chip in the header, its body bound in the same soft blue bubble as an agent
// reply so it reads as the agent's voice) — float to the top, marked with the primary "your turn"
// dot in the header's right corner. Below them the rest recede (an open item, the already-sent long thread whose
// replies fold to the last three — agent replies get a soft blue tinted fill,
// human replies render as plain prose — plus the general/whole-file/summary
// notes). "Copy prompt" is enabled — the unsent items still have content.
export const Default: Story = {};

// The attention split on its own: cards where the agent had the last word rank to
// the top with the "your turn" dot, above the rest (your open notes +
// human-last-reply threads), which recede below. Replying to a top card (you get
// the last word) or resolving it sinks it below the attention group; a fresh agent
// reply raises a card back up.
export const AttentionOrdering: Story = {};

// A card made active (amber left rail + faint wash) with its reply composer opened via a click on
// "Reply" (the composer is local state, not driven by activeFeedbackId). Its ⋯
// menu's Edit targets the last thing the human wrote (their last reply, else the
// feedback body) and is disabled once the agent has replied last.
export const ActiveMultiReply: Story = {
  args: { activeFeedbackId: "feedback_thread" },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>('[data-fb-card="feedback_thread"]');
    if (card) await userEvent.click(within(card).getByRole("button", { name: "Reply" }));
  },
};

// ⋯ → Edit on a card whose last message is a human reply: the reply turns into an
// editor in place and the bottom action row becomes Save/Cancel (replacing the
// Reply button), instead of a second Save/Cancel row under the editor.
export const EditingReply: Story = {
  args: { activeFeedbackId: "feedback_thread" },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>('[data-fb-card="feedback_thread"]');
    if (!card) return;
    await userEvent.click(within(card).getByTitle("More actions"));
    await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  },
};

// ⋯ → Edit on a card with no replies: the feedback body turns into an editor and
// the same bottom-row Save/Cancel drives it.
export const EditingBody: Story = {
  args: { activeFeedbackId: "feedback_pragma" },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>('[data-fb-card="feedback_pragma"]');
    if (!card) return;
    await userEvent.click(within(card).getByTitle("More actions"));
    await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  },
};

// Everything delivered: no unsent content anywhere, so "Copy prompt" is
// disabled with the "everything has been sent" title (a new reply re-enables it).
export const AllSent: Story = {
  args: { detail: allSentDetail },
};

// The Resolved tab, reached by activating a resolved item (the panel switches
// tabs to reveal it). The active resolved card offers Reopen instead of Resolve.
export const ResolvedTab: Story = {
  args: { activeFeedbackId: "feedback_resolved" },
};

// An agent is on `r3 watch` — the action switches to "Submit to agent" and a
// live presence indicator appears.
export const AgentWatching: Story = {
  parameters: { queryData: [[WATCHERS_KEY, watching]] },
};

// A line range was just picked in the diff → the anchored-draft composer opens at
// the bottom of the list (embedded-block style, primary left rail), below the
// existing feedback, so a newly-added card lands right where you were typing.
export const NewFeedbackComposer: Story = {
  args: { pending: pendingAnchor },
};

// The whole-file composer, opened from a file header's feedback button: the label
// is the bare path (no ":Lx"), and there's no quote block since a whole-file note
// has no span. Committing it POSTs a file-only anchor (null line/quote).
export const WholeFileComposer: Story = {
  args: { pending: wholeFilePendingAnchor },
};

// The general-note composer, opened from the header's "+" (Add general feedback)
// — same embedded block style as the anchored draft (primary left rail), pinned to
// the bottom of the list. Only one composer is ever open, so opening this cancels
// any pending draft.
export const GeneralComposer: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add general feedback" }),
    );
  },
};

// A draft with text: the header shows the "unsaved draft" chip and the agent
// hand-off ("Submit to agent" / "Copy prompt") is disabled until it's
// added or discarded — it lives only in the browser, not on the server.
export const UnsavedDraft: Story = {
  args: { pending: pendingAnchor },
  decorators: [withAnchoredDraft("This assumes the WAL pragma is idempotent — is it?")],
};

export const UnsavedDraftWatching: Story = {
  args: { pending: pendingAnchor },
  decorators: [withAnchoredDraft("This assumes the WAL pragma is idempotent — is it?")],
  parameters: { queryData: [[WATCHERS_KEY, watching]] },
};

// The composer auto-grows with its text (autogrow.ts): a multi-line draft opens
// already expanded to fit rather than clipped to the short default. Past ~10
// lines it stops growing and scrolls instead — the tall band here sits just under
// that cap.
export const GrownComposer: Story = {
  args: { pending: pendingAnchor },
  decorators: [
    withAnchoredDraft(
      [
        "The retry loop here re-opens the connection on every attempt, which",
        "defeats the WAL — each new handle starts a fresh transaction and can't",
        "see the checkpoint the previous attempt wrote.",
        "",
        "Two options:",
        "  1. hoist the open() out of the loop, or",
        "  2. pass the existing handle down so retries share it.",
      ].join("\n"),
    ),
  ],
};

// Clicking a card's file:line path highlights it (amber left rail + faint wash) and scrolls the
// diff/files pane to the anchored line.
export const ActiveCard: Story = {
  args: { activeFeedbackId: "feedback_pragma" },
};

// Messages render as Markdown: the `feedback_pragma` body shows bold + inline
// `code` + a bullet list, and an `@server/db.ts:L11-12` reference rendered as a
// clickable jump chip. Its agent thread (`feedback_thread`) has a reply with a
// fenced code block and its own `@ref`. Selecting text inside any agent-voiced
// content — an agent reply or an agent-authored feedback body (`feedback_agent_note`)
// — raises the "Quote in reply" bubble (not visible in a static snapshot).
export const MarkdownMessages: Story = {
  args: { activeFeedbackId: "feedback_pragma" },
};

// No feedback yet → the empty prompt to select text in the diff/files.
export const Empty: Story = {
  args: { detail: { ...reviewDetail, feedback: [] } },
};

// The phone tier: below md every shared Button in the card action rows and the
// composer grows to a 44px touch target, and the composer/reply/edit inputs lift
// to 16px so iOS won't zoom on focus. Rendered sub-md so those max-md: variants
// engage (they key on the viewport, not a wrapper width); the viewport is a touch
// wider than a phone only so the panel's fixed 440px story frame still fits.
export const Mobile: Story = {
  args: { pending: pendingAnchor },
  parameters: phoneViewport(520, 860, "Phone (panel frame)"),
};
