import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { MessageProse, QuoteBubble } from "./Message.tsx";

// An agent-reply-shaped body: Markdown blocks, an inline `@path:Lx-y` jump ref,
// and an explicit URL — the only kind that auto-links (fuzzy linkify is off, so
// a bare filename like README.md stays plain text).
const REPLY =
  "Fixed — the pragma block now sets `busy_timeout` **before** the first statement:\n\n" +
  "```ts\n" +
  'db.exec("PRAGMA busy_timeout = 5000;");\n' +
  "```\n\n" +
  "- landed in round 2 — see @server/db.ts:L13\n" +
  "- docs: https://sqlite.org/pragma.html\n" +
  "- README.md is untouched (bare filenames don't linkify)";

const meta = {
  title: "Components/Message",
  component: MessageProse,
  // The card context: message prose sits inside a feedback card at panel width.
  decorators: [
    (Story) => (
      <div className="w-[420px] bg-white p-4 dark:bg-neutral-950">
        <Story />
      </div>
    ),
  ],
  args: {
    source: REPLY,
    className: "text-sm leading-relaxed text-neutral-700 dark:text-neutral-200",
    onJumpRef: fn(),
  },
} satisfies Meta<typeof MessageProse>;

export default meta;
type Story = StoryObj<typeof meta>;

// The full Markdown surface: bold + inline code, a fenced block, a list, the
// `@server/db.ts:L13` ref rendered as a `.r3-ref` chip (clicking it fires
// onJumpRef; Enter works too — the chip is a real focusable link), and the
// explicit https:// URL as the one external link.
export const Markdown: Story = {};

// Plain text round-trips: single newlines render as line breaks (breaks:true),
// matching the whitespace-pre-wrap feel messages had before Markdown rendering.
export const PlainText: Story = {
  args: {
    source: "Two short lines,\nbroken exactly where they were typed.\n\nAnd a second paragraph.",
  },
};

// Raw HTML is escaped, not injected (markdown-it html:false) — the tags render
// as visible text, which is what makes the output safe for dangerouslySetInnerHTML.
export const EscapedHtml: Story = {
  args: {
    source: "<b>not bold</b> <img src=x onerror=alert(1)> — raw HTML shows as text.",
  },
};

// The floating "quote this selection" button both selection-to-quote flows share
// ("Quote in reply" on an agent reply, "Quote in note" over the file pane).
// Fixed-positioned off the live selection rect in real use; pinned here.
export const Bubble: Story = {
  render: () => (
    <QuoteBubble
      pos={{ left: 210, top: 60, text: "the selected passage" }}
      label="Quote in reply"
      onQuote={fn()}
    />
  ),
};
