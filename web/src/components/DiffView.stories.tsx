import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { type CSSProperties, useState } from "react";
import { phoneViewport } from "../storyViewport.ts";
import { multiRound, singleRound, wideRound } from "./_fixtures.ts";
import { DiffView, RoundSelect, RoundSummary } from "./DiffView.tsx";

const meta = {
  title: "Components/DiffView",
  component: DiffView,
  args: {
    rounds: singleRound,
    isViewed: (_key: string): boolean => false,
    toggle: fn(),
    onPickLines: fn(),
  },
  argTypes: {
    rounds: { control: false },
    isViewed: { control: false },
  },
} satisfies Meta<typeof DiffView>;

export default meta;
type Story = StoryObj<typeof meta>;

// One stored round (the common case — no round headers): a modified file
// (add/del/context rows), an added file, and a binary file. Click or drag the
// line-number gutter to fire `onPickLines` (see Actions).
export const Default: Story = {};

// Two rounds — a follow-up diff addressing feedback. Only one round
// renders at a time; with no `activeSeq` it defaults to the latest (diff 2).
// The round's summary is NOT part of DiffView — ReviewView mounts RoundSummary
// itself (see MultiRoundWithSwitcher for the assembled stack).
export const MultiRound: Story = {
  args: { rounds: multiRound },
};

// The full multi-round experience as ReviewView assembles it: a toolbar with the
// `RoundSelect` dropdown docked to the right, the active round's `RoundSummary`
// at the top of the scroll pane (foldable "Diff summary", styled like the review
// summary), and the selected round wired through `activeSeq`. Open the dropdown
// to switch rounds; the newest wears a "latest" badge.
export const MultiRoundWithSwitcher: Story = {
  args: { rounds: multiRound },
  render: (args) => {
    const [seq, setSeq] = useState<number>(multiRound[multiRound.length - 1].seq);
    const round = multiRound.find((r) => r.seq === seq) ?? multiRound[multiRound.length - 1];
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center border-b border-neutral-300 bg-white px-1.5 py-0.5 dark:border-neutral-700 dark:bg-neutral-950">
          {/* Mirrors PaneToolbar's full-height, flush-right slot so the embedded
              switcher renders the same here as in the app. */}
          <div className="-my-0.5 -mr-1.5 ml-auto flex items-stretch self-stretch">
            <RoundSelect rounds={multiRound} activeSeq={seq} onSelect={setSeq} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RoundSummary round={round} onAnchorSummary={fn()} onJumpRef={fn()} />
          <DiffView {...args} activeSeq={seq} />
        </div>
      </div>
    );
  },
};

// A viewed file collapses to just its header. Viewed is keyed per round
// (d:<seq>:<path>), so we match on the path suffix regardless of the round seq.
export const SomeViewed: Story = {
  args: { isViewed: (key) => key.endsWith(":server/ids.ts") },
};

// No rounds with content.
export const NoChanges: Story = {
  args: { rounds: [] },
};

// A line wider than the panel: the file gets ONE horizontal scrollbar (not one
// per line), the line-number gutter stays frozen to the left while only the code
// scrolls, and the short rows' add/del backgrounds span the full scroll width.
export const WideLines: Story = {
  args: { rounds: wideRound },
};

// The phone tier: below md the two 3rem gutter columns compress to 2.25rem so the
// code gets more of the narrow screen, and the frozen new-side gutter re-pins
// (left-12 → left-9) to stay glued to the old column. Sized to a 390px phone so
// the max-md: variants actually engage (they key on the viewport, not a wrapper
// width); wideRound scrolls horizontally, showing the compressed rail stay frozen.
export const Mobile: Story = {
  args: { rounds: wideRound },
  parameters: phoneViewport(),
};

// The code surface paints on the syntax theme's OWN background: in the app,
// ReviewView sets --shiki-*-bg / --shiki-* on the content pane from
// /api/theme-style and DiffView paints against them (add/del are translucent
// overlays; the frozen gutter blends the theme surface). Here we fake Nord's
// colours so the themed surface is visible without a running server. (FileView
// shares the same .shiki-surface mechanism.)
export const NordSurface: Story = {
  args: { rounds: wideRound },
  decorators: [
    (Story) => (
      <div
        style={
          {
            "--shiki-light-bg": "#2e3440",
            "--shiki-dark-bg": "#2e3440",
            "--shiki-light": "#d8dee9",
            "--shiki-dark": "#d8dee9",
          } as CSSProperties
        }
      >
        <Story />
      </div>
    ),
  ],
};
