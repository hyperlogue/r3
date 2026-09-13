import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type PreviewSecurityState, previewSecuritySummary } from "../preview-security.ts";
import { ChevronDown, cn, StrokeIcon } from "../ui.tsx";

type Entry = PreviewSecurityState & { path: string; controls: ReactNode };
function createRegistry() {
  const entries = new Map<string, Entry>();
  let snapshot: (Entry & { id: string })[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    snapshot = [...entries].map(([id, entry]) => ({ ...entry, id }));
    for (const listener of listeners) listener();
  };
  return {
    get: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (id: string, entry: Entry) => {
      entries.set(id, entry);
      changed();
    },
    remove: (id: string) => {
      entries.delete(id);
      changed();
    },
  };
}
const SecurityContext = createContext<ReturnType<typeof createRegistry> | null>(null);

export function ArtifactPreviewSecurityProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createRegistry);
  return <SecurityContext value={registry}>{children}</SecurityContext>;
}

// Preview sessions retain policy and device ownership. Only the nav subscribes
// to this presentation registry, so status changes do not rerender the workspace.
export function ArtifactPreviewSecuritySource({
  children,
  ...entry
}: PreviewSecurityState & {
  path: string;
  children: ReactNode;
}) {
  const registry = useContext(SecurityContext);
  const id = useId();
  useLayoutEffect(() => {
    registry?.set(id, { ...entry, controls: children });
  });
  useLayoutEffect(() => () => registry?.remove(id), [registry, id]);
  return registry ? null : children;
}

export function ArtifactPreviewSecurity() {
  const registry = useContext(SecurityContext);
  return registry ? <SecurityIndicator registry={registry} /> : null;
}

function SecurityIndicator({ registry }: { registry: ReturnType<typeof createRegistry> }) {
  const entries = useSyncExternalStore(registry.subscribe, registry.get);
  const summary = previewSecuritySummary(entries);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  useEffect(() => {
    if (!entries.length) setOpen(false);
  }, [entries.length]);
  return (
    <div
      hidden={!entries.length}
      className="mb-3 border-b border-neutral-200 pb-3 dark:border-neutral-800"
      data-preview-security={summary.state}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`Preview security: ${summary.label}`}
        aria-expanded={open}
        aria-controls={contentId}
        title={`Preview security: ${summary.label}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-xs hover:bg-neutral-100 max-md:min-h-9 dark:hover:bg-neutral-800",
          summary.state === "verified"
            ? "text-emerald-700 dark:text-emerald-400"
            : summary.state === "limited"
              ? "text-amber-700 dark:text-amber-400"
              : summary.state === "sharing" || summary.state === "error"
                ? "text-red-700 dark:text-red-400"
                : "text-neutral-500 dark:text-neutral-400",
        )}
      >
        <StrokeIcon className="size-4 shrink-0">
          <path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z" />
          {summary.state === "verified" ? (
            <path d="m8 12 3 3 5-6" />
          ) : summary.state === "sharing" ? (
            <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
          ) : summary.state === "error" ? (
            <path d="m9 9 6 6m0-6-6 6" />
          ) : (
            <path d="M12 8v5m0 3h.01" />
          )}
        </StrokeIcon>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Preview security</span>
          <span className="block">{summary.label}</span>
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      <span role="status" className="sr-only">
        {summary.label}
      </span>
      <section
        id={contentId}
        hidden={!open}
        aria-label="Preview security details"
        className="mt-2 text-sm"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !document.querySelector("dialog:modal")) {
            event.stopPropagation();
            if (!event.repeat) {
              setOpen(false);
              trigger.current?.focus();
            }
          }
        }}
      >
        {entries.map((entry) => (
          <section
            key={entry.id}
            className="border-t border-neutral-200 py-3 first:border-0 dark:border-neutral-800"
          >
            <h3 className="mb-2 break-all text-xs font-semibold">{entry.path}</h3>
            {entry.controls}
          </section>
        ))}
      </section>
    </div>
  );
}
