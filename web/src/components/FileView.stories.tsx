import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { fn } from "storybook/test";
import { getSyntaxTheme } from "../settings.ts";
import { phoneViewport } from "../storyViewport.ts";
import { renderedCode, renderedMarkdown } from "./_fixtures.ts";
import { FileView } from "./FileView.tsx";

const REVIEW_ID = "review_remote";
const REF = "WORKING";
// FileView's blob query key includes the active syntax theme; read the live
// value so the seed key matches what the component will look up.
const theme = getSyntaxTheme();

const meta = {
  title: "Components/FileView",
  component: FileView,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    reviewId: REVIEW_ID,
    refName: REF,
    viewed: false,
    toggle: fn(),
    onSha: fn(),
    onPickLines: fn(),
  },
} satisfies Meta<typeof FileView>;

export default meta;
type Story = StoryObj<typeof meta>;

// A syntax-highlighted code file. Click/drag the gutter to anchor feedback.
export const Code: Story = {
  args: { path: renderedCode.path },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedCode.path, REF, theme], renderedCode]],
  },
};

// A markdown file renders HTML by default; the header toggle switches to the
// (line-anchorable) raw source. Its relative links are in-review doc links: the
// review here holds AGENTS.md, so that one is live (clicking jumps the pane to
// it) while CONTRIBUTING.md, which isn't in the review, renders dead. A mermaid
// flowchart fence renders as an inline SVG, not highlighted source.
export const Markdown: Story = {
  args: {
    path: renderedMarkdown.path,
    hasFile: (p: string) => p === "AGENTS.md",
    onDocLink: fn(),
  },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedMarkdown.path, REF, theme], renderedMarkdown]],
  },
};

// Marked viewed → folded to just the header. `viewed` is the boolean the parent
// computes (from the loaded content sha); here it's forced on.
export const Viewed: Story = {
  args: { path: renderedCode.path, viewed: true },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedCode.path, REF, theme], renderedCode]],
  },
};

// A file the review still lists that the worktree no longer has. The blob query
// resolves the missing sentinel instead of throwing, so the 404 is cached data —
// no retry storm, no refetch on every viewport re-entry — and the card says why
// rather than showing a raw `GET /api/blob… → 404`.
const GONE = "server/legacy/ids.ts";
export const Missing: Story = {
  args: { path: GONE },
  parameters: { queryData: [[["blob", REVIEW_ID, GONE, REF, theme], { missing: true }]] },
};

// Scrolled out of the preload band: the body unmounts (which is what lets its
// blob be garbage-collected) while the shell keeps the header from the metadata
// the last body reported — the viewed toggle's sha key, the fold, and (this file
// being markdown) the rendered/raw toggle. Mounts active for one beat, then
// deactivates; the button flips it back the way scrolling back would.
export const Inactive: Story = {
  args: { path: renderedMarkdown.path },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedMarkdown.path, REF, theme], renderedMarkdown]],
  },
  render: (args) => <ScrolledAway {...args} />,
};

function ScrolledAway(args: ComponentProps<typeof FileView>) {
  const [active, setActive] = useState(true);
  useEffect(() => {
    setActive(false);
  }, []);
  return (
    <>
      <FileView {...args} active={active} />
      <button
        type="button"
        onClick={() => setActive((a) => !a)}
        className="mt-3 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
      >
        {active ? "Leave the preload band" : "Re-enter the preload band"}
      </button>
    </>
  );
}

// The marks a review paints over rendered markdown. useRegionHighlight and
// useActiveLineHighlight live in ReviewView, so this story stands in for them and
// tags the blocks by hand — what it covers is the CSS. The two table ROWS are the
// case to watch: their gutter bar has to hang on the row's first cell, because an
// absolutely positioned child of a `table-row` box is wrapped in an anonymous
// table cell — which lands as an extra empty leading column on the marked row
// alone, shunting its cells out of line with every other row's.
export const MarkedBlocks: Story = {
  args: { path: renderedMarkdown.path },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedMarkdown.path, REF, theme], renderedMarkdown]],
  },
  render: (args) => <WithMarks {...args} />,
};

// data-line-start → the class the hooks would have added: a paragraph, a list
// item, and the fixture table's two <tbody> rows, one of each treatment.
const MARKS: [line: number, cls: string][] = [
  [3, "r3-feedback-region"],
  [6, "r3-active-line"],
  [10, "r3-feedback-region"],
  [11, "r3-active-line"],
];

function WithMarks(args: ComponentProps<typeof FileView>) {
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The body mounts a frame or two after the card's header, so keep trying
    // until every block is there.
    let raf = requestAnimationFrame(function mark() {
      const found = MARKS.filter(([line, cls]) => {
        const el = holder.current?.querySelector(`[data-line-start="${line}"]`);
        el?.classList.add(cls);
        return el != null;
      });
      if (found.length < MARKS.length) raf = requestAnimationFrame(mark);
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={holder}>
      <FileView {...args} />
    </div>
  );
}

// The phone tier: below md the single 3.5rem line-number gutter compresses to
// 2.5rem (padding tightened) to give the code more of the narrow screen; a
// 4-digit line number still fits. Sized to a 390px phone so the max-md: variant
// engages (it keys on the viewport, not a wrapper width).
export const Mobile: Story = {
  args: { path: renderedCode.path },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedCode.path, REF, theme], renderedCode]],
    ...phoneViewport(),
  },
};
