import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import { shortSha, sourceLabel } from "../format.ts";
import type { ReviewDetail, ReviewStatus } from "../types.ts";
import { Button, cn } from "../ui.tsx";

// A click-to-copy token in the header's metadata line (project dir, commit
// range, branch, session). Underlines on hover, copies `value` on click, and
// flashes a "Copied" bubble. The bubble is `position: fixed` (measured off the
// button rect) rather than absolute so it escapes the metadata line's `truncate`
// overflow-hidden clip.
function CopyMeta({
  value,
  hint,
  children,
}: {
  value: string;
  hint: string;
  children: React.ReactNode;
}) {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    // Measure before awaiting — React nulls currentTarget after the handler.
    const r = e.currentTarget.getBoundingClientRect();
    if (!(await copyText(value))) return;
    setTip({ left: r.left + r.width / 2, top: r.top - 4 });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip(null), 1200);
  };
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        title={hint}
        className="cursor-pointer rounded-sm hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {children}
      </button>
      {tip && (
        <span
          role="status"
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded bg-neutral-800 px-1.5 py-0.5 font-sans text-[0.625rem] font-medium text-white shadow dark:bg-neutral-700"
          style={{ left: tip.left, top: tip.top }}
        >
          Copied
        </span>
      )}
    </>
  );
}

// The review title, editable in place: the text (falling back to the source
// label when untitled) with a hover pencil; click it or double-click the title
// to open an input. Enter / blur saves, Esc cancels. Passing null clears the
// title back to the source-label fallback.
function EditableTitle({
  title,
  placeholder,
  onSave,
}: {
  title: string | null;
  placeholder: string;
  onSave: (title: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Grow the input to fit its content so it hugs the text and widens only as the
  // user types, instead of stretching to fill the row. (width:0 → scrollWidth is
  // the standard auto-size trick; the browser paints once, so there's no flash.)
  const autoSize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.width = "0";
    el.style.width = `${el.scrollWidth + 2}px`;
  }, []);

  const startEditing = () => {
    setDraft(title ?? "");
    setEditing(true);
  };
  useEffect(() => {
    if (editing) {
      autoSize();
      inputRef.current?.select();
    }
  }, [editing, autoSize]);

  const commit = () => {
    const trimmed = draft.trim();
    onSave(trimmed ? trimmed : null);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
        autoFocus
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autoSize();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder={placeholder}
        // -my-px offsets the border so the editor is exactly the display height —
        // opening it never grows the row. Width auto-sizes to content (min keeps
        // it usable when empty, max keeps it inside the row). max-md:text-base
        // keeps iOS from zooming when the title field takes focus on a phone.
        className="-my-px min-w-[3rem] max-w-full rounded border border-primary-400 bg-white px-1 text-sm font-semibold outline-none max-md:text-base dark:bg-neutral-900"
      />
    );
  }
  return (
    <div className="group flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={startEditing}
        title="Rename review"
        // max-md:text-base keeps the display the same size as the edit input
        // (which lifts to 16px+ below md against iOS zoom-on-focus), so opening
        // the editor never grows the header row on a phone either.
        className="min-w-0 cursor-text truncate text-left text-sm font-semibold max-md:text-base"
      >
        {title || placeholder}
      </button>
      <button
        type="button"
        onClick={startEditing}
        title="Rename review"
        className="shrink-0 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 group-hover:opacity-100 pointer-coarse:opacity-100 dark:hover:text-neutral-300"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3.5"
        >
          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          <path d="m15 5 4 4" />
        </svg>
      </button>
    </div>
  );
}

// The approve confirmation: a small modal capturing optional "next steps for the
// agent", which `r3 watch` prints to the agent when it sees the approval. Empty
// is fine — approving with no note is the common case. Escape / backdrop / Cancel
// dismiss without approving.
function ApproveDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop: a real button so a click outside cancels (no nested-click hacks) */}
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div className="relative w-full max-w-md rounded-lg border border-neutral-300 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          Approve review
        </h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Optionally leave next steps for the agent — delivered when it picks up the result.
        </p>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the dialog is opened by an explicit Approve click
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // ⌘/Ctrl+Enter approves without reaching for the mouse (the note is
          // optional, so no content guard — an empty note is the common case).
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onConfirm(note.trim());
            }
          }}
          placeholder="Next steps for the agent (optional)…"
          rows={3}
          // max-md:text-base keeps iOS from zooming when this note field takes
          // focus on a phone (the Approve flow is reachable on mobile).
          className="mt-3 w-full resize-y rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-primary-500 focus:outline-none max-md:text-base dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="success" onClick={() => onConfirm(note.trim())}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

// Review-header status controls: the primary Approve/Reopen button, plus a ⋯
// menu holding the rarer, heavier actions (Abandon, Delete) so they don't crowd
// the header. Approve opens a confirm dialog (optional next-steps note); Delete
// is tinted danger-red — it destroys the review and its feedback. Same popover
// mechanics as the feedback card's ⋯ menu (click-catcher + Escape).
function HeaderActions({
  status,
  unresolvedCount,
  onSetStatus,
  onApprove,
  onDelete,
}: {
  status: ReviewStatus;
  // How many of the *human's* feedback items are still open (status !== "resolved"
  // && author === "human"). Approve is blocked while any remain — approving is the
  // review's terminal success, so it shouldn't skip past feedback that never got a
  // decision. Agent-authored notes (guidance, questions) rank into the attention
  // zone but must not block the human's terminal action: the server and CLI enforce
  // no gate at all, so this is purely a UI guardrail against skipping your own
  // undecided feedback, not the agent's.
  unresolvedCount: number;
  onSetStatus: (s: ReviewStatus) => void;
  onApprove: (note: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <>
      {status === "open" ? (
        <Button
          variant="success"
          onClick={() => setApproveOpen(true)}
          disabled={unresolvedCount > 0}
          title={
            unresolvedCount > 0
              ? `Resolve your open feedback first — ${unresolvedCount} still ${unresolvedCount === 1 ? "needs a" : "need"} decision${unresolvedCount === 1 ? "" : "s"}`
              : undefined
          }
        >
          Approve
        </Button>
      ) : (
        <Button onClick={() => onSetStatus("open")}>Reopen</Button>
      )}
      <div className="relative">
        <Button variant="ghost" onClick={() => setMenuOpen((o) => !o)} title="More actions">
          ⋯
        </Button>
        {menuOpen && (
          <>
            {/* click-catcher: closes the menu when clicking elsewhere */}
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div className="absolute top-full right-0 z-50 mt-1 w-32 overflow-hidden rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
              {status === "open" && (
                <button
                  type="button"
                  onClick={() => {
                    onSetStatus("abandoned");
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Abandon
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-danger-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
      {approveOpen && (
        <ApproveDialog
          onCancel={() => setApproveOpen(false)}
          onConfirm={(note) => {
            setApproveOpen(false);
            onApprove(note);
          }}
        />
      )}
    </>
  );
}

// The review header row: status pill · editable title · the copyable metadata
// line (repo/dir, kind, commit range or source label, branch, session) · the
// Approve/⋯ actions. ReviewView owns its placement — desktop pins it above the
// split, mobile mounts it inside the scroll pane so it scrolls away with the
// rest of the header stack. max-md: the actions row wraps under the title
// instead of crushing it.
export function ReviewHeader({
  detail,
  onSaveTitle,
  onSetStatus,
  onApprove,
  onDelete,
}: {
  detail: ReviewDetail;
  onSaveTitle: (title: string | null) => void;
  onSetStatus: (s: ReviewStatus) => void;
  onApprove: (note: string) => void;
  onDelete: () => void;
}) {
  // Copyable metadata-line values. The project dir is the review's worktree (an
  // absolute path); `commit` is the diff review's base/head provenance (raw
  // refs, not the shortened display shas), split into three copy targets below.
  const projectDir = detail.worktree?.pathHint || null;
  const commit =
    "base" in detail.source && (detail.source.base || detail.source.head) ? detail.source : null;

  return (
    <div className="flex items-center gap-2 border-b border-neutral-300 bg-white px-3 py-2 max-md:flex-wrap dark:border-neutral-700 dark:bg-neutral-950">
      <div className="min-w-0 flex-1 max-md:basis-full">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "shrink-0 rounded border px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase leading-none",
              detail.status === "open"
                ? "border-transparent bg-primary-100 text-primary-700 dark:bg-primary-950 dark:text-primary-300"
                : detail.status === "approved"
                  ? "border-success-500 bg-success-50 text-success-700 dark:border-success-500 dark:bg-success-950 dark:text-success-300"
                  : "border-transparent bg-neutral-200 text-neutral-500 dark:bg-neutral-800",
            )}
          >
            {detail.status}
          </span>
          <EditableTitle
            title={detail.title}
            placeholder={sourceLabel(detail, { ref: true })}
            onSave={onSaveTitle}
          />
        </div>
        <div className="truncate font-mono text-[0.6875rem] text-neutral-400">
          {detail.repoName ? (
            <>
              {projectDir ? (
                <CopyMeta value={projectDir} hint={`Copy path: ${projectDir}`}>
                  {detail.repoName}
                </CopyMeta>
              ) : (
                detail.repoName
              )}
              {" · "}
            </>
          ) : (
            ""
          )}
          {detail.kind} ·{" "}
          {commit ? (
            <>
              <CopyMeta value={commit.base} hint={`Copy base commit: ${commit.base}`}>
                {shortSha(commit.base)}
              </CopyMeta>
              <CopyMeta
                value={`${commit.base}..${commit.head}`}
                hint={`Copy commit range: ${commit.base}..${commit.head}`}
              >
                ..
              </CopyMeta>
              <CopyMeta value={commit.head} hint={`Copy head commit: ${commit.head}`}>
                {shortSha(commit.head)}
              </CopyMeta>
            </>
          ) : (
            sourceLabel(detail, { ref: true })
          )}
          {detail.branch ? (
            <>
              {" · ⎇ "}
              <CopyMeta value={detail.branch} hint={`Copy branch: ${detail.branch}`}>
                {detail.branch}
              </CopyMeta>
            </>
          ) : (
            ""
          )}
          {detail.meta.session ? (
            <>
              {" · "}
              <CopyMeta value={detail.meta.session} hint={`Copy: ${detail.meta.session}`}>
                {detail.meta.session}
              </CopyMeta>
            </>
          ) : (
            ""
          )}
        </div>
      </div>
      <HeaderActions
        status={detail.status}
        unresolvedCount={
          detail.feedback.filter((f) => f.status !== "resolved" && f.author === "human").length
        }
        onSetStatus={onSetStatus}
        onApprove={onApprove}
        onDelete={onDelete}
      />
    </div>
  );
}
