import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { useRef } from "react";
import { AddFeedbackPill } from "./AddFeedbackPill.tsx";

// The pill is selection-driven, so the story is a real selectable code pane: the
// rows carry the same data-file / data-line / data-side attributes DiffView emits,
// which is all getSelectionAnchor needs to resolve a selection to an anchor.
// Select across one or more lines to raise the pill (on a coarse pointer in the
// app; a mouse drag works here). fn() reports the tap.
const LINES = [
  { n: 1, text: "export function greet(name: string) {" },
  { n: 2, text: "  const msg = greeting(name);" },
  { n: 3, text: "  console.log(msg);" },
  { n: 4, text: "  return msg;" },
  { n: 5, text: "}" },
];

function Harness({ composing }: { composing: boolean }) {
  const scopeRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <p className="mb-2 text-xs text-neutral-500">
        Select text in the code below to raise the pill.
      </p>
      <div
        ref={scopeRef}
        className="overflow-x-auto rounded border border-neutral-300 dark:border-neutral-700"
      >
        <div data-file="src/greet.ts">
          {LINES.map(({ n, text }) => (
            <div
              key={n}
              data-line={n}
              data-side="new"
              className="grid grid-cols-[3rem_1fr] font-mono text-xs"
            >
              <span className="select-none border-r border-neutral-300/70 px-2 text-right text-neutral-400 dark:border-neutral-700">
                {n}
              </span>
              <code className="px-2 whitespace-pre">{text}</code>
            </div>
          ))}
        </div>
      </div>
      <AddFeedbackPill scopeRef={scopeRef} composing={composing} onAdd={fn()} />
    </div>
  );
}

const meta = {
  title: "Mobile/AddFeedbackPill",
  component: AddFeedbackPill,
  // Frame it phone-narrow; the pill itself is fixed to the viewport, so it floats
  // over the selection wherever it lands — the real geometry on a phone.
  decorators: [
    (Story) => (
      <div className="w-[390px] border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
        <Story />
      </div>
    ),
  ],
  args: {
    // Presentational args are unused — the Harness owns scopeRef + onAdd — but the
    // meta needs them to satisfy the component's prop types.
    scopeRef: { current: null },
    composing: false,
    onAdd: fn(),
  },
  argTypes: {
    scopeRef: { control: false },
    onAdd: { control: false },
  },
} satisfies Meta<typeof AddFeedbackPill>;

export default meta;
type Story = StoryObj<typeof meta>;

// Empty composer: the tap would anchor a new note.
export const AddFeedback: Story = {
  render: () => <Harness composing={false} />,
};

// Composer already holds text: the tap would quote the selection into it, so the
// pill reads "Quote in note" (the desktop QuoteBubble's wording).
export const QuoteInNote: Story = {
  render: () => <Harness composing={true} />,
};
