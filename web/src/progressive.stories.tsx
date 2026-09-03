import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import {
  ProgressiveFile,
  ProgressiveFileProvider,
  type ReserveSpec,
  useProgressiveFileController,
} from "./progressive.tsx";

// Each demo file is a row list, like a real code body: one 1rem row per line, so
// a `{ kind: "code", rows }` reserve is exactly right and the pane's height can
// be checked against it.
const rowsFor = (index: number) => 12 + ((index * 83) % 420);

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
        src/file-{String(index + 1).padStart(3, "0")}.ts · {rowsFor(index)} rows
      </div>
      {active && (
        <div data-demo-body className="bg-white font-mono text-xs dark:bg-neutral-950">
          {Array.from({ length: rowsFor(index) }, (_, r) => (
            <div key={r} className="h-4 px-2 leading-4 text-neutral-400">
              {r + 1}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressiveDemo({ count, reserve }: { count: number; reserve: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressive = useProgressiveFileController();
  const [mounted, setMounted] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const update = () => {
      setMounted(root.querySelectorAll("[data-demo-body]").length);
      setHeight(root.scrollHeight);
    };
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });
    const resize = new ResizeObserver(update);
    resize.observe(root);
    update();
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
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
          {mounted}/{count} bodies · scrollHeight {height.toLocaleString()}px
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
            const spec: ReserveSpec = { folded: false, kind: "code", rows: rowsFor(index) };
            return (
              <ProgressiveFile
                key={path}
                path={path}
                version="working:github"
                reserve={reserve ? spec : null}
              >
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
  args: { count: 200, reserve: true },
} satisfies Meta<typeof ProgressiveDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

// Two hundred stable file blocks share one observer. Only bodies in the pane's
// preload band mount; scrolling retires bodies behind it while measured shells
// retain the continuous scroll geometry. "Jump last" exercises forced activation.
//
// Watch `scrollHeight` in the HUD: with a reserve it is the real total from the
// first frame and holds still while you scroll.
export const LargeReview: Story = {};

// The same review with no ReserveSpec — the flat INITIAL_HEIGHT fallback. The
// HUD's scrollHeight starts far off and climbs with every body that lands, which
// is what makes the scrollbar useless: the thumb shrinks and drifts under the
// cursor as you drag it.
export const WithoutReserve: Story = {
  args: { reserve: false },
};
