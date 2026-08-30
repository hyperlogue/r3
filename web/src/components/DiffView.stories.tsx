import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useRef, useState } from "react";
import { fn } from "storybook/test";
import { ProgressiveFileProvider, useProgressiveFileController } from "../progressive.tsx";
import { phoneViewport } from "../storyViewport.ts";
import type { PatchDiff } from "../types.ts";
import { expandableRound, multiRound, singleRound, wideRound } from "./_fixtures.ts";
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

// Side-by-side: old on the left, new on the right, paired so a rewritten line
// reads across one row instead of two stacked ones. Unmatched adds/deletions get
// an inert filler cell opposite them (no line number — not anchorable). Each half
// is its own horizontal scroll container with its own frozen gutter, and the two
// stay vertically locked because VirtualLines sizes every row identically.
// Gutter click/drag anchors exactly as in unified; a drag can't cross the divider.
export const SplitLayout: Story = {
  args: { layout: "split" },
};

// Split with a wide line: proves the halves scroll independently — scrolling the
// left column's long line does NOT drag the right column out of view.
export const SplitWideLines: Story = {
  args: { rounds: wideRound, layout: "split" },
};

// Split across rounds: the layout is a display preference, orthogonal to which
// round is shown, so the switcher and the toggle compose without interacting.
export const SplitMultiRound: Story = {
  args: { rounds: multiRound, layout: "split" },
};

// Expand-context. The server marks each hunk row with how many unchanged lines
// it HOLDS but didn't render (`expandable`); the separator then becomes the
// expander — ⌃/⌄ reveal a step at either end, the label reveals the whole gap,
// and a gap whose edges meet loses its separator entirely. Revealed rows are
// ordinary context rows: selectable and gutter-anchorable, which is the point —
// today you can't leave feedback on a line more than 3 lines from a change.
// Without `fetchContext` (as in every other story) no expander is offered at all,
// which is exactly how a round holding nothing spare behaves — one stored before
// wide capture, or piped at `-U3` or narrower.
const revealContext = async (_file: string, start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => ({
    type: "context" as const,
    oldLine: start + i,
    newLine: start + i,
    // Default-foreground text ships with no wrapper (server/highlight.ts).
    html: `  // revealed line ${start + i}`,
    text: `  // revealed line ${start + i}`,
  }));

export const ExpandableContext: Story = {
  args: { rounds: expandableRound, fetchContext: revealContext },
};

// The two features crossed — the configuration where a row-height slip shows up
// worst. An expander lives in the LEFT half only (never two per gap), so if that
// separator rendered at anything but one line height the halves would drift apart
// by the difference at every gap. Both columns must stay level here, before and
// after revealing rows.
export const SplitExpandableContext: Story = {
  args: { rounds: expandableRound, fetchContext: revealContext, layout: "split" },
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

// Past the size gate — PROGRESSIVE_FILES_MIN files OR PROGRESSIVE_ROWS_MIN
// rendered rows — ReviewView wraps the content pane in a
// ProgressiveFileProvider and each block hydrates only near the viewport. Every
// OTHER story here mounts no provider, which is the eager render this component
// has always done and still does for anything under the gate. Scroll the pane:
// a block renders its rows as it enters the preload band and keeps the height it
// measured after it leaves, so nothing under it jumps. What never defers is the
// shell — header, fold triangle, viewed pill, [data-file] box — so the
// scroll-spy, fold-all and a jump's activation all still find every file.
const bigRound: PatchDiff[] = [
  {
    seq: 1,
    label: "26 files · ~4.7k rows",
    summary: null,
    created_at: "2026-06-30T12:00:00.000Z",
    files: Array.from({ length: 26 }, (_, i) => ({
      oldPath: `web/src/module-${i + 1}.ts`,
      newPath: `web/src/module-${i + 1}.ts`,
      path: `web/src/module-${i + 1}.ts`,
      status: "modified" as const,
      binary: false,
      additions: 1,
      deletions: 1,
      lines: Array.from({ length: 180 }, (_, n) => {
        const type = n === 0 ? "hunk" : n === 90 ? "del" : n === 91 ? "add" : "context";
        const text =
          type === "hunk" ? `@@ -1,180 +1,180 @@ module ${i + 1}` : `  const line${n} = ${n};`;
        return {
          type,
          oldLine: type === "hunk" || type === "add" ? null : n,
          newLine: type === "hunk" || type === "del" ? null : n,
          text,
          html: text,
        };
      }),
    })),
  },
];

export const ProgressiveHydration: Story = {
  args: { rounds: bigRound },
  render: (args) => {
    // The provider observes against the scroll pane, so the story supplies the
    // one ReviewView would. A fixed height, not `h-full`: the observer's root is
    // this box, and a box as tall as its content intersects everything at once —
    // every block would activate and the story would show the eager render.
    const scrollRef = useRef<HTMLDivElement>(null);
    const progressive = useProgressiveFileController();
    return (
      <div ref={scrollRef} className="h-[70vh] overflow-y-auto">
        <ProgressiveFileProvider
          scrollRef={scrollRef}
          registry={progressive.registry}
          enabled={true}
        >
          <DiffView {...args} progressiveVersion="story:1" />
        </ProgressiveFileProvider>
      </div>
    );
  },
};
