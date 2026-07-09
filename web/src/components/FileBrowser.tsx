import { useMemo, useState } from "react";
import { Collapse, cn, FoldChevrons, FoldTriangle } from "../ui.tsx";

// Left-of-center panel listing the files in the current review as a directory
// tree. Clicking a file scrolls the center view to that file's block; viewed
// files are dimmed + ticked.

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[]; // full paths of files directly in this dir
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = node.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.push(p);
  }
  return root;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// Fold a chain of single-child directories into one row: while a dir holds
// exactly one sub-dir and no files of its own, absorb the child's name so
// aaa/bbb/ccc/ddd.ts reads as "aaa/bbb/ccc > ddd.ts" instead of four nested rows.
function collapseChain(name: string, node: DirNode): { label: string; node: DirNode } {
  let label = name;
  let cur = node;
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const [childName, childNode] = [...cur.dirs.entries()][0];
    label = `${label}/${childName}`;
    cur = childNode;
  }
  return { label, node: cur };
}

function FileLink({
  path,
  label,
  viewed,
  active,
  onSelect,
}: {
  path: string;
  label: string;
  viewed: boolean;
  active: boolean;
  onSelect: (p: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      title={path}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[0.6875rem] transition-colors",
        active
          ? "bg-neutral-200/70 dark:bg-neutral-800"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60",
        viewed && "text-neutral-400 dark:text-neutral-500",
      )}
    >
      <span
        className={cn(
          "w-2 shrink-0 text-[0.5625rem]",
          viewed ? "text-success-600 dark:text-success-400" : "text-transparent",
        )}
      >
        ✓
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function TreeDir({
  node,
  prefix,
  depth,
  viewed,
  activePath,
  onSelect,
}: {
  node: DirNode;
  prefix: string;
  depth: number;
  viewed: Set<string>;
  activePath: string | null;
  onSelect: (p: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dirNames = [...node.dirs.keys()].sort();
  const files = [...node.files].sort();
  const pad = (d: number) => ({ paddingLeft: `${d * 0.75}rem` });

  return (
    <div>
      {dirNames.map((name) => {
        const { label, node: child } = collapseChain(name, node.dirs.get(name)!);
        const full = prefix ? `${prefix}/${label}` : label;
        const isCollapsed = collapsed.has(label);
        return (
          <div key={full}>
            <button
              type="button"
              onClick={() =>
                setCollapsed((s) => {
                  const n = new Set(s);
                  n.has(label) ? n.delete(label) : n.add(label);
                  return n;
                })
              }
              style={pad(depth)}
              className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[0.6875rem] text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60"
            >
              {/* size-2.5 + gap-1 = the file rows' w-2 tick + gap-1.5, so dir
                  labels and file names share a left edge. */}
              <FoldTriangle open={!isCollapsed} className="size-2.5" />
              <span className="truncate font-medium">{label}/</span>
            </button>
            <Collapse open={!isCollapsed}>
              <TreeDir
                node={child}
                prefix={full}
                depth={depth + 1}
                viewed={viewed}
                activePath={activePath}
                onSelect={onSelect}
              />
            </Collapse>
          </div>
        );
      })}
      {files.map((f) => (
        <div key={f} style={pad(depth)}>
          <FileLink
            path={f}
            label={base(f)}
            viewed={viewed.has(f)}
            active={f === activePath}
            onSelect={onSelect}
          />
        </div>
      ))}
    </div>
  );
}

export function FileBrowser({
  files,
  viewed,
  activePath,
  onSelect,
}: {
  files: string[];
  viewed: Set<string>;
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("r3-filebrowser-collapsed") === "1",
  );
  const setCollapsedPersist = (v: boolean) => {
    localStorage.setItem("r3-filebrowser-collapsed", v ? "1" : "0");
    setCollapsed(v);
  };
  const viewedCount = files.filter((f) => viewed.has(f)).length;
  // Rebuilding the tree on every render is wasted work — the scroll-spy in the
  // parent re-renders this on every scroll (activePath), but `files` is stable.
  const tree = useMemo(() => buildTree(files), [files]);

  // One <aside> for both states so the width transition animates the fold: the
  // collapsed rail (whole rail = the expand target) and the expanded tree swap
  // inside it at fixed widths, clipped while the panel slides.
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r border-neutral-300 bg-white transition-[width] duration-200 dark:border-neutral-700 dark:bg-neutral-950",
        collapsed ? "w-8" : "w-56",
      )}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsedPersist(false)}
          title="Show files"
          className="flex min-h-0 w-8 flex-1 flex-col items-center gap-2 py-2 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <FoldChevrons dir="right" />
          <span className="text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 [writing-mode:vertical-rl]">
            Files · {files.length}
          </span>
        </button>
      ) : (
        <div className="flex min-h-0 w-56 flex-1 flex-col">
          {/* The chevron leads the header at the exact spot it occupies in the
              collapsed rail (pl-2 = the rail's centering offset for a size-4
              icon in w-8, same py) — the toggle stays put under the pointer. */}
          <div className="flex items-center justify-between py-2 pr-3 pl-2 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCollapsedPersist(true)}
                title="Hide files"
                className="flex text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <FoldChevrons dir="left" />
              </button>
              <span className="truncate">Files · {files.length}</span>
            </div>
            {viewedCount > 0 && (
              <span className="shrink-0 text-success-600 dark:text-success-400">
                {viewedCount}/{files.length} viewed
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            <TreeDir
              node={tree}
              prefix=""
              depth={0}
              viewed={viewed}
              activePath={activePath}
              onSelect={onSelect}
            />
          </div>
        </div>
      )}
    </aside>
  );
}
