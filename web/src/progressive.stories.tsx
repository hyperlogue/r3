import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import {
  ProgressiveFile,
  ProgressiveFileProvider,
  useProgressiveFileController,
} from "./progressive.tsx";

function DemoFile({
  index,
  active,
  onHydrated,
  onOpenChange,
}: {
  index: number;
  active: boolean;
  onHydrated: (ready: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (active) onHydrated(true);
  }, [active, onHydrated]);
  useEffect(() => onOpenChange(true), [onOpenChange]);
  return (
    <div>
      <div className="flex h-8 items-center border-b border-neutral-300 bg-neutral-50 px-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900">
        src/file-{String(index + 1).padStart(3, "0")}.ts
      </div>
      {active && (
        <div
          data-demo-body
          className="border-b border-neutral-300 bg-white p-3 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
          style={{ height: 90 + ((index * 83) % 520) }}
        >
          progressively mounted body {index + 1}
        </div>
      )}
    </div>
  );
}

function ProgressiveDemo({ count }: { count: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressive = useProgressiveFileController();
  const [mounted, setMounted] = useState(0);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const update = () => setMounted(root.querySelectorAll("[data-demo-body]").length);
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, []);

  const jump = (path: string) => {
    progressive.activate(path);
    const root = scrollRef.current;
    const target = root?.querySelector(`[data-file="${CSS.escape(path)}"]`);
    if (!root || !target) return;
    root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
  };

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-30 flex items-center gap-2 rounded bg-neutral-900/90 px-2 py-1 text-[0.6875rem] text-neutral-100">
        <span className="font-mono">
          {mounted} bodies mounted / {count} files
        </span>
        <button
          type="button"
          className="rounded bg-white/15 px-1.5 py-0.5 hover:bg-white/25"
          onClick={() => jump(`src/file-${String(count).padStart(3, "0")}.ts`)}
        >
          Jump last
        </button>
      </div>
      <div
        ref={scrollRef}
        className="shiki-surface h-[480px] overflow-y-auto rounded-lg border border-neutral-300 dark:border-neutral-700"
      >
        <ProgressiveFileProvider scrollRef={scrollRef} registry={progressive.registry} enabled>
          {Array.from({ length: count }, (_, index) => {
            const path = `src/file-${String(index + 1).padStart(3, "0")}.ts`;
            return (
              <ProgressiveFile key={path} path={path} version="working:github">
                {(state) => <DemoFile index={index} {...state} />}
              </ProgressiveFile>
            );
          })}
        </ProgressiveFileProvider>
      </div>
    </div>
  );
}

const meta = {
  title: "Primitives/ProgressiveFiles",
  component: ProgressiveDemo,
  parameters: { layout: "padded" },
  args: { count: 200 },
} satisfies Meta<typeof ProgressiveDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

// Two hundred stable file blocks share one observer. Only bodies in the pane's
// preload band mount; scrolling retires bodies behind it while measured shells
// retain the continuous scroll geometry. "Jump last" exercises forced activation.
export const LargeReview: Story = {};
