import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { cn } from "./ui.tsx";
import { useVirtualPaneController, VirtualLines, VirtualPaneProvider } from "./virtual.tsx";

// A self-contained harness for the VirtualLines primitive: a fixed-height scroll
// pane (the role ReviewView's content pane plays) wrapping a long list of mono
// "code" rows. A live badge reports which [data-line] rows are actually mounted
// vs the list length, so the windowing is visible — scroll and the mounted span
// stays bounded no matter the list size, and its ENDS only move when the viewport
// crosses a 48-row block boundary (that quantization is what keeps a scroll from
// mutating the pane's DOM every frame).
function VirtualDemo({ count }: { count: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { registry } = useVirtualPaneController();
  const [mounted, setMounted] = useState("");

  // Poll the mounted window each frame so the badge tracks scrolling.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const rows = scrollRef.current?.querySelectorAll("[data-line]");
      const n = rows?.length ?? 0;
      const first = rows?.[0]?.getAttribute("data-line");
      const last = rows?.[n - 1]?.getAttribute("data-line");
      setMounted(n ? `rows ${first}–${last} (${n})` : "0 rows");
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 rounded bg-neutral-900/85 px-2 py-1 font-mono text-[0.6875rem] text-neutral-100">
        {mounted} mounted / {count.toLocaleString()} total
      </div>
      <div
        ref={scrollRef}
        className="shiki-surface h-[480px] overflow-y-auto rounded-lg border border-neutral-300 dark:border-neutral-700"
      >
        <VirtualPaneProvider scrollRef={scrollRef} registry={registry}>
          <div className="overflow-x-auto">
            <VirtualLines
              className="min-w-max"
              count={count}
              itemKey={(i) => i}
              renderRow={(i) => (
                <div
                  className="grid min-w-full grid-cols-[3.5rem_1fr] font-mono text-xs"
                  data-line={i + 1}
                  data-side="new"
                >
                  <span className="gutter-surface sticky left-0 z-0 border-r border-neutral-300/70 px-2 text-right text-neutral-400 select-none dark:border-neutral-700">
                    {i + 1}
                  </span>
                  <code className="shiki-code px-2 whitespace-pre">
                    {`const line_${i + 1} = ${"x".repeat((i * 7) % 60)}; // row ${i + 1}`}
                  </code>
                </div>
              )}
            />
          </div>
        </VirtualPaneProvider>
      </div>
    </div>
  );
}

const meta = {
  title: "Primitives/VirtualLines",
  component: VirtualDemo,
  parameters: { layout: "padded" },
  argTypes: { count: { control: { type: "number" } } },
} satisfies Meta<typeof VirtualDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

// A 5,000-row list: only the on-screen window mounts. Scroll fast — the badge's
// span stays small while the content scrolls the full height, and it steps in
// 48-row blocks rather than following the wheel row by row. This is what keeps a
// thousand-line file's DOM (and any DOM-walking browser extension) light.
export const Virtualized: Story = {
  args: { count: 5000 },
};

// Below VIRTUALIZE_MIN (150): the primitive renders every row (no windowing, no
// spacer machinery) — the mounted span is the whole list. Short files take this
// path in the app.
export const ShortRendersInFull: Story = {
  args: { count: 40 },
};

// The horizontal-scroll extent grows to the widest MOUNTED row (rows here vary in
// width). Scroll down to a wider row and the file's horizontal scrollbar extends.
export const WideRows: Story = {
  args: { count: 2000 },
  render: (args) => (
    <div className={cn("text-sm")}>
      <VirtualDemo {...args} />
    </div>
  ),
};
