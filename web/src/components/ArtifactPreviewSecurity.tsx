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
import { suspendKeys } from "../keys.ts";
import { type PreviewSecurityState, previewSecuritySummary } from "../preview-security.ts";
import { Button, cn, StrokeIcon } from "../ui.tsx";

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
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  useEffect(() => {
    if (!entries.length) setOpen(false);
  }, [entries.length]);
  useEffect(() => {
    if (!open) return;
    const resume = suspendKeys();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const iframeFocus = () => {
      if (document.activeElement instanceof HTMLIFrameElement) setOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", iframeFocus);
    return () => {
      window.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", iframeFocus);
      resume();
    };
  }, [open]);
  return (
    <div hidden={!entries.length} className="shrink-0" data-preview-security={summary.state}>
      <button
        ref={trigger}
        type="button"
        aria-label={`Preview security: ${summary.label}`}
        aria-expanded={open}
        aria-controls={contentId}
        title={`Preview security: ${summary.label}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex items-center justify-center rounded-md p-1.5 hover:bg-neutral-100 max-md:size-9 dark:hover:bg-neutral-800",
          summary.state === "verified"
            ? "text-emerald-700 dark:text-emerald-400"
            : summary.state === "limited"
              ? "text-amber-700 dark:text-amber-400"
              : summary.state === "sharing" || summary.state === "error"
                ? "text-red-700 dark:text-red-400"
                : "text-neutral-500 dark:text-neutral-400",
        )}
      >
        <StrokeIcon className="size-4">
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
      </button>
      <span role="status" className="sr-only">
        {summary.label}
      </span>
      <section
        id={contentId}
        hidden={!open}
        aria-label="Preview security details"
        className="absolute right-2 top-full z-50 mt-1 max-h-[calc(100dvh-4rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-neutral-300 bg-white p-3 text-sm text-neutral-900 shadow-xl dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="font-semibold">Preview security</span>
          <Button
            variant="ghost"
            aria-label="Close preview security"
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            ×
          </Button>
        </div>
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
