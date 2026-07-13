import type { AutoAnimationPlugin } from "@formkit/auto-animate";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useAutoGrow } from "../autogrow.ts";
import { copyText } from "../clipboard.ts";
import {
  clearGeneral,
  getDraft,
  pruneReplyDrafts,
  setDraftText,
  setGeneralText,
  setReplyText,
  useDraftCount,
  useDraftText,
  useGeneralDraft,
  useReplyDraft,
} from "../drafts.ts";
import type { MessageRef } from "../markdown.ts";
import type { PendingAnchor } from "../selection.ts";
import type {
  Author,
  Feedback,
  FeedbackWithReplies,
  Reply,
  ReviewDetail,
  WatcherInfo,
  WatchersResponse,
} from "../types.ts";
import { SUMMARY_FILE } from "../types.ts";
import {
  Button,
  Collapse,
  CommentPlusIcon,
  cn,
  FoldTriangle,
  scrollParent,
  TrashIcon,
  useCopyFlash,
} from "../ui.tsx";
import { MessageProse, QuoteBubble, quoteBlock, useQuoteBubble } from "./Message.tsx";

// Custom auto-animate plugins BYPASS its built-in reduced-motion guard (index.mjs
// gates that on `!isPlugin`), so every plugin below checks this and collapses its
// duration to 0. (CSS-driven motion — Collapse, r3-* keyframes — is guarded in CSS.)
const prefersReduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Feedback cards: a new card fades in fast then glides up into place; a removed card
// slides straight out to the right, off the panel (clipped by listRef's
// overflow-x-hidden), fading as it goes; the rest FLIP into their new slots.
const feedbackAnimation: AutoAnimationPlugin = (el, action, a, b) => {
  const reduce = prefersReduced();
  // The zone divider ("no response needed") between the attention groups isn't a
  // card — fade it in/out in place instead of the card's rise-in / slide-off-right.
  const isDivider = el instanceof HTMLElement && el.dataset.zoneDivider != null;
  if (action === "add") {
    if (isDivider) {
      return new KeyframeEffect(el, [{ opacity: 0 }, { opacity: 1 }], {
        duration: reduce ? 0 : 200,
        easing: "ease-out",
      });
    }
    // Fade fast (opacity done by offset 0.3) while the translateY glides the whole
    // (longer) duration — the fade is much quicker than the rise. Opacity +
    // translateY only, so the block never scales or resizes.
    return new KeyframeEffect(
      el,
      [
        { opacity: 0, transform: "translateY(1.25rem)", offset: 0 },
        { opacity: 1, offset: 0.3 },
        { opacity: 1, transform: "translateY(0)", offset: 1 },
      ],
      { duration: reduce ? 0 : 250, easing: "ease-out" },
    );
  }
  if (action === "remove") {
    if (isDivider) {
      return new KeyframeEffect(el, [{ opacity: 1 }, { opacity: 0 }], {
        duration: reduce ? 0 : 150,
        easing: "ease-in",
      });
    }
    // Straight right, Y locked to 0 — an explicit 2D translate (not translateX) so
    // there is no chance of a stray vertical component — fading as it exits.
    return new KeyframeEffect(
      el,
      [
        { transform: "translate(0, 0)", opacity: 1 },
        { transform: "translate(100%, 0)", opacity: 0 },
      ],
      { duration: reduce ? 0 : 200, easing: "ease-in" },
    );
  }
  // remain: FLIP from the old box to the new one. Runtime passes
  // (el, "remain", oldCoords, newCoords) — so `a` is old, `b` is new.
  const dx = (a?.left ?? 0) - (b?.left ?? 0);
  const dy = (a?.top ?? 0) - (b?.top ?? 0);
  return new KeyframeEffect(
    el,
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    { duration: reduce ? 0 : 200, easing: "ease-out" },
  );
};

// The reply thread: a new reply just fades in — no scale (auto-animate's default
// scale(.98)→1 was unwanted). Removals fade out; the visible pair reflows via FLIP.
const replyAnimation: AutoAnimationPlugin = (el, action, a, b) => {
  const reduce = prefersReduced();
  if (action === "add") {
    return new KeyframeEffect(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: reduce ? 0 : 250,
      easing: "ease-out",
    });
  }
  if (action === "remove") {
    return new KeyframeEffect(el, [{ opacity: 1 }, { opacity: 0 }], {
      duration: reduce ? 0 : 200,
      easing: "ease-in",
    });
  }
  const dx = (a?.left ?? 0) - (b?.left ?? 0);
  const dy = (a?.top ?? 0) - (b?.top ?? 0);
  return new KeyframeEffect(
    el,
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    { duration: reduce ? 0 : 200, easing: "ease-out" },
  );
};

// Human-readable target for summary feedback (the `file` sentinel + patch_seq):
// the review's own summary, or a specific diff round's.
function summaryTargetLabel(patchSeq: number | null | undefined): string {
  return patchSeq != null ? `diff ${patchSeq} summary` : "review summary";
}

// Show only the modifier that actually works on this machine: ⌘ on macOS, Ctrl
// elsewhere. The submit handlers accept either (metaKey || ctrlKey) — the hint
// shouldn't make the user pick.
const SUBMIT_KEYS = (() => {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const platform =
    (nav as (Navigator & { userAgentData?: { platform?: string } }) | null)?.userAgentData
      ?.platform ||
    nav?.platform ||
    "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘Enter" : "Ctrl+Enter";
})();

// True when focus is on an element that should own the keystroke itself — a text
// field (which receives the character) or an interactive control like a button or
// link (Space activates it; Esc may dismiss its own popup). A global Space/Esc
// shortcut must stand down for these so it doesn't hijack normal interaction.
function isInteractiveTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "BUTTON" ||
    tag === "A" ||
    el.isContentEditable ||
    el.getAttribute("role") === "button"
  );
}

const shortLabel = (s: string) => (s.length > 14 ? `${s.slice(0, 12)}…` : s);
function watchersLabel(watchers: WatcherInfo[]): string {
  if (watchers.length === 1) return shortLabel(watchers[0].session);
  if (watchers.length === 2) return watchers.map((w) => shortLabel(w.session)).join(", ");
  return `${watchers.length} agents`;
}
function watchersTitle(watchers: WatcherInfo[]): string {
  return `watching: ${watchers.map((w) => (w.agentId ? `${w.session} (${w.agentId})` : w.session)).join(", ")}`;
}

// Copy the agent prompt. Uses copyText (not navigator.clipboard directly) so it
// works on the daemon's remote/insecure-origin bind, where navigator.clipboard is
// undefined; a failed copy flashes "Copy failed" instead of silently doing
// nothing. Two useCopyFlash timers — success and failure — reuse the shared,
// unmount-safe flash logic rather than hand-rolling another timer.
//
// Preview-then-mark: fetch the text with the non-marking GET preview, copy it,
// and only stamp it delivered (POST prompt) once the clipboard write LANDED. A
// failed copy (permission denied, unfocused doc, execCommand fallback failing on
// a remote bind) must leave sent_at untouched — otherwise the SSE refetch would
// disable Copy AND Submit and the hand-off would be silently lost with no
// in-browser way to retry.
function useCopyPrompt(reviewId: string) {
  const { copied, flash } = useCopyFlash();
  const { copied: failed, flash: flashFailed } = useCopyFlash(2000);
  const copy = async () => {
    let ok = false;
    try {
      const text = await api.promptPreview(reviewId);
      ok = await copyText(text);
      // Mark delivered only after a successful copy; the server rebuilds+marks
      // the unsent set. A failed copy skips this, so the unsent state stands.
      if (ok) await api.prompt(reviewId);
    } catch {
      ok = false;
    }
    (ok ? flash : flashFailed)();
  };
  return { copied, failed, copy };
}

// A click that concluded a drag-selection shouldn't also fire the element's
// action (jump / expand) — otherwise the anchor line and the quoted code can't
// be selected to copy. A plain click leaves the selection collapsed (a caret),
// so the action still fires; a drag leaves a non-collapsed selection, which we
// read as "the user is copying text, don't act."
function clickEndedInSelection(): boolean {
  const sel = window.getSelection();
  return sel != null && !sel.isCollapsed && sel.toString().length > 0;
}

function locLabel(fb: FeedbackWithReplies): string {
  if (fb.file === SUMMARY_FILE) return summaryTargetLabel(fb.patch_seq);
  if (!fb.file) return "general";
  // Name the round when the anchor lives past the first one — in a multi-round
  // review "db.ts:L11" alone is ambiguous.
  const round = fb.patch_seq != null && fb.patch_seq > 1 ? `d${fb.patch_seq} · ` : "";
  if (fb.line_start == null) return `${round}${fb.file}`;
  const range =
    fb.line_end && fb.line_end !== fb.line_start
      ? `L${fb.line_start}-${fb.line_end}`
      : `L${fb.line_start}`;
  return `${round}${fb.file.split("/").pop()}:${range}`;
}

// A feedback "needs you" when the agent had the last word and it isn't resolved —
// the same turn boundary that gates Edit (canEdit below). Drives the attention-
// first ordering of the active list and the per-card unread dot: once you reply
// (you get the last word) or resolve it, it drops out of the attention zone.
function needsAttention(fb: FeedbackWithReplies): boolean {
  if (fb.status === "resolved") return false;
  return (fb.replies.at(-1)?.author ?? fb.author) === "agent";
}

// The "pending input" look shared by the new-feedback composer and the per-card
// reply box: not a floating bordered widget but a full-bleed strip embedded into
// the block — no side border, no radius, a faint recessed fill marking "this is
// an input awaiting your text", closed off by top/bottom rules that warm to
// primary on focus. The caller supplies the full-bleed width (a self `-mx-3` for
// the composer; the reply box's Collapse wrapper carries it, since that wrapper's
// overflow-hidden would otherwise clip a margin on the textarea itself).
// The height is driven inline by useAutoGrow (autogrow.ts) — the box grows with
// its text up to a line cap, then scrolls.
const PENDING_INPUT =
  "resize-none border-y border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-primary-400 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100 dark:placeholder:text-neutral-500";

// The shared composer shell for both the anchored draft (NewFeedback) and the
// general note (GeneralFeedback): the primary-rail block, a header (label slot +
// ✕), an optional quote, the auto-growing textarea (⌘/Ctrl+Enter submits), and
// the Cancel/Add button row. The two wrappers own only what genuinely differs —
// their mutation, label, quote, keyboard affordances, and button/placeholder text
// — so the composer's look lives in exactly one place.
function ComposerBlock({
  label,
  labelMono,
  quote,
  textareaRef,
  value,
  onChange,
  placeholder,
  autoFocus,
  submitLabel,
  onSubmit,
  submitPending,
  onClose,
  anchored,
}: {
  label: ReactNode;
  labelMono?: boolean;
  quote?: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (s: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  submitPending: boolean;
  onClose: () => void;
  // Tags the anchored composer's textarea (data-anchored-composer) so a file-pane
  // "Quote in note" click can find + focus it from ReviewView (a different subtree).
  anchored?: boolean;
}) {
  const growRef = useAutoGrow(textareaRef, value, 3);
  return (
    // Embedded-block style shared with the saved feedback blocks: flush to the
    // panel (no rounded box, no tinted fill) with a primary left rail marking the
    // in-progress draft — the parallel of a saved block's amber active rail. The
    // divider around the composer region is owned by that region, not this block.
    <div className="border-l-2 border-l-primary-400 p-3 dark:border-l-primary-500">
      <div className="mb-1.5 flex items-center justify-between text-[0.6875rem] text-neutral-500">
        <span
          className={cn(
            "font-medium text-primary-700 dark:text-primary-300",
            labelMono && "font-mono",
          )}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          ✕
        </button>
      </div>
      {quote != null && (
        <pre className="mb-3 max-h-24 overflow-auto border-l-2 border-neutral-300 pl-2 font-mono text-xs whitespace-pre-wrap break-words text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {quote}
        </pre>
      )}
      <textarea
        ref={growRef}
        data-anchored-composer={anchored ? "" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) onSubmit();
        }}
        placeholder={placeholder}
        // biome-ignore lint/a11y/noAutofocus: composers open on an explicit user action (click / range select)
        autoFocus={autoFocus}
        // Full-bleed to the block's edges (-mx-3 cancels the p-3), so the input
        // reads as an embedded band rather than a boxed widget. Height is
        // auto-grown from useAutoGrow above (no fixed h-*).
        className={cn("-mx-3 w-[calc(100%_+_1.5rem)]", PENDING_INPUT)}
      />
      <div className="mt-3 flex justify-end gap-1.5">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!value.trim() || submitPending} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// Shared composer keyboard affordances for the two draft composers (the anchored
// note and the general note), so they behave identically. Esc cancels the composer
// only when it's *empty* (mirrors the reply box), so a half-typed note isn't lost
// to a stray keypress; with text, Esc just blurs the focused input — and both stand
// down when focus is on some other control/popup so this global listener doesn't
// hijack its keys (e.g. Esc closing the settings popup). `spaceToFocus` (only the
// non-autofocused selection composers) lets Space — when focus isn't already on a
// field/control — jump focus into the input; an autofocused composer omits it so
// Space always types a space normally.
function useComposerKeys(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onCancel: () => void,
  spaceToFocus: boolean,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ta = textareaRef.current;
      const active = document.activeElement;
      if (e.key === "Escape") {
        const empty = !(ta?.value ?? "").trim();
        if (active === ta || !isInteractiveTarget(active)) {
          e.preventDefault();
          if (empty) onCancel();
          else if (active === ta) ta?.blur();
        }
        return;
      }
      if (spaceToFocus && (e.key === " " || e.code === "Space") && !isInteractiveTarget(active)) {
        e.preventDefault(); // also stops Space from page-scrolling the diff
        ta?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, textareaRef, spaceToFocus]);
}

// A free-form feedback item not tied to any file or line (review-level note). Its
// text lives in the browser draft store (drafts.ts), so it persists across a
// review-switch/reload and lights the hand-off pill — same as the anchored draft.
function GeneralFeedback({
  reviewId,
  onClose,
  onCommit,
}: {
  reviewId: string;
  // onClose discards the general note (clears the draft + closes); onCommit hands
  // the panel the new row (optimistic insert + cache reconcile + close).
  onClose: () => void;
  onCommit: (fb: Feedback) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const value = useGeneralDraft(reviewId);
  // Same keyboard behavior as the anchored composer: autofocus (below) + Esc
  // cancels when empty. onClose already clears the draft + closes. No Space-to-focus
  // — the input is autofocused, so Space must type a space, not jump focus.
  useComposerKeys(textareaRef, onClose, false);
  const add = useMutation({
    mutationFn: () =>
      api.addFeedback(reviewId, {
        lineStart: null,
        lineEnd: null,
        body: value,
        author: "human",
      }),
    onSuccess: (fb) => onCommit(fb),
  });
  return (
    <ComposerBlock
      label="General feedback"
      textareaRef={textareaRef}
      value={value}
      onChange={(t) => setGeneralText(reviewId, t)}
      placeholder={`A note about the review as a whole…  (${SUBMIT_KEYS} to add · Esc to cancel)`}
      autoFocus
      submitLabel="Save"
      onSubmit={() => add.mutate()}
      submitPending={add.isPending}
      onClose={onClose}
    />
  );
}

function NewFeedback({
  reviewId,
  pending,
  onDiscard,
  onCommit,
}: {
  reviewId: string;
  pending: PendingAnchor;
  onDiscard: () => void;
  // The panel owns the post-create work (optimistic insert + cache reconcile +
  // draft clear), so a successful add just hands it the new row. onDiscard stays
  // for Cancel/✕.
  onCommit: (fb: Feedback) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The anchored note lives in the browser draft store, keyed to this review.
  const draftText = useDraftText(reviewId);

  // A whole-file anchor (a real path, no line span) only comes from the file
  // header's feedback button — a deliberate composer-open click, like "add general
  // feedback", so focus the input immediately (below). A selection/gutter/summary
  // anchor is a text gesture in the file pane; autofocusing there would yank focus
  // off the code, so those keep the Space-to-focus flow instead.
  const autoFocusInput = pending.file !== SUMMARY_FILE && pending.lineStart == null;

  // Esc-cancels-when-empty (shared with the general note); Space-to-focus only for
  // the non-autofocused selection composers, so an autofocused input types spaces.
  useComposerKeys(textareaRef, onDiscard, !autoFocusInput);

  const add = useMutation({
    mutationFn: () =>
      api.addFeedback(reviewId, {
        file: pending.file,
        side: pending.side,
        lineStart: pending.lineStart,
        lineEnd: pending.lineEnd,
        quote: pending.quote,
        body: draftText,
        author: "human",
        patchSeq: pending.patchSeq ?? null,
      }),
    onSuccess: (fb) => onCommit(fb),
  });

  const label =
    pending.file === SUMMARY_FILE ? (
      summaryTargetLabel(pending.patchSeq)
    ) : pending.lineStart == null ? (
      // Whole-file note — no span; name the file itself.
      pending.file
    ) : (
      <>
        {pending.file.split("/").pop()}:L{pending.lineStart}
        {pending.lineEnd !== pending.lineStart ? `-${pending.lineEnd}` : ""}
      </>
    );

  return (
    <ComposerBlock
      label={label}
      labelMono
      quote={pending.quote}
      textareaRef={textareaRef}
      value={draftText}
      onChange={(t) => setDraftText(reviewId, t)}
      placeholder={
        autoFocusInput
          ? `Leave feedback…  (${SUBMIT_KEYS} to add · Esc to cancel)`
          : `Leave feedback…  (Space to focus · ${SUBMIT_KEYS} to add · Esc to cancel)`
      }
      autoFocus={autoFocusInput}
      submitLabel="Add feedback"
      onSubmit={() => add.mutate()}
      submitPending={add.isPending}
      anchored
      onClose={onDiscard}
    />
  );
}

// One reply in a feedback thread. Only the agent's voice gets a soft tinted fill
// (faint primary blue) — a bubble that sets the responder apart. A human reply is
// the human's own voice, same as the feedback body above it, so it renders as
// plain prose flush with the body rather than a second styled block; that also
// keeps it from reading as quoted text (the left-border idiom belongs to the
// anchor quote). The author rides in the title for hover/accessibility.
function ReplyBlock({
  rp,
  editing,
  editValue,
  onEditChange,
  onEditSave,
  onEditCancel,
  canSave,
  onLocatePin,
  onJumpRef,
}: {
  rp: Reply;
  // The card puts its *last human reply* into edit mode (see FeedbackCard); every
  // other reply renders read-only. The editor is controlled from the card so its
  // Save/Cancel can live in the card's bottom action row (shared with body edits).
  editing: boolean;
  editValue: string;
  onEditChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  canSave: boolean;
  onLocatePin: (patchSeq: number, file: string | null, line: number | null) => void;
  // Jump the pane to an `@path:Lx-y` ref clicked inside this reply's rendered
  // Markdown (already bound with the reply's version context by the card).
  onJumpRef?: (ref: MessageRef) => void;
}) {
  const isAgent = rp.author === "agent";
  const editRef = useRef<HTMLTextAreaElement>(null);
  const editGrowRef = useAutoGrow(editRef, editValue, 3);
  return (
    <div
      title={rp.author}
      data-reply-author={rp.author}
      className={cn(
        "text-xs",
        isAgent && "rounded-md bg-primary-100/60 px-2.5 py-1.5 dark:bg-primary-500/15",
      )}
    >
      {editing ? (
        <textarea
          ref={editGrowRef}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) onEditSave();
            else if (e.key === "Escape") onEditCancel();
          }}
          // biome-ignore lint/a11y/noAutofocus: the editor is opened by an explicit Edit click
          autoFocus
          // Full-bleed band (matches the composer / reply box), not a boxed
          // widget: -mx-3 cancels the card's p-3 so it spans edge to edge. Save/Cancel
          // live in the card's bottom action row, not here. Height auto-grows.
          className={cn("-mx-3 w-[calc(100%_+_1.5rem)]", PENDING_INPUT)}
        />
      ) : (
        // First-class content — same size as the feedback body and the file view,
        // rendered as Markdown. Relaxed leading so long agent replies don't read as
        // a wall of text.
        <MessageProse
          source={rp.body}
          className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-200"
          onJumpRef={onJumpRef}
        />
      )}
      {/* Anchored reply: where the change addressing this feedback landed
          — jump to the pinned round/file/line. */}
      {rp.patch_seq != null && !editing && (
        <button
          type="button"
          onClick={() => onLocatePin(rp.patch_seq!, rp.file, rp.line_start)}
          className="mt-1 block truncate font-mono text-[0.6875rem] text-success-700 hover:text-success-600 dark:text-success-400 dark:hover:text-success-300"
          title={`Jump to diff ${rp.patch_seq}${rp.file ? ` · ${rp.file}` : ""}`}
        >
          ↳ addressed in diff {rp.patch_seq}
          {rp.file
            ? ` · ${rp.file.split("/").pop()}${rp.line_start ? `:L${rp.line_start}` : ""}`
            : ""}
        </button>
      )}
    </div>
  );
}

function FeedbackCard({
  fb,
  reviewId,
  onLocate,
  onLocatePin,
  onResolved,
  onJumpRef,
  isActive,
}: {
  fb: FeedbackWithReplies;
  reviewId: string;
  onLocate: () => void;
  onLocatePin: (patchSeq: number, file: string | null, line: number | null) => void;
  onResolved: () => void;
  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message.
  onJumpRef: (ref: MessageRef, patchSeq: number | null) => void;
  isActive: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["review", reviewId] });
  // The in-progress reply lives in the browser draft store (drafts.ts), keyed by
  // review + this feedback's id — so it survives a review-switch/reload and lights
  // the hand-off pill, same as the new-feedback composers. setReply("") drops it.
  const reply = useReplyDraft(reviewId, fb.id);
  const setReply = useCallback((t: string) => setReplyText(reviewId, fb.id, t), [reviewId, fb.id]);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(fb.body);
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The reply composer is hidden by default; the action row (Resolve · ⋯ · Reply)
  // stays put, and clicking "Reply" reveals the textarea. Kept local so it's
  // independent of `isActive` (which only highlights the card + its region). Seeded
  // open when a persisted reply draft is waiting, so it restores on reload/switch.
  const [replyOpen, setReplyOpen] = useState(
    () => (getDraft(reviewId)?.replies[fb.id]?.trim() ?? "") !== "",
  );
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Animate a new reply sliding into the thread (and the reflow when the oldest of
  // the shown pair rolls up into the "earlier" fold) — the same treatment the
  // feedback list gets. Scoped to the visible last-two container; the folded
  // earlier ones already animate via their Collapse.
  const [replyAnim] = useAutoAnimate<HTMLDivElement>(replyAnimation);
  // Which reply (if any) is being edited inline — only ever the last human reply,
  // set by the Edit action below.
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const replyGrowRef = useAutoGrow(replyRef, reply, 2);
  // Selecting text inside one of this card's agent replies raises a "Quote in
  // reply" bubble; clicking it drops the selection into the reply draft as a `>`
  // blockquote and opens the composer, caret past the quote (quoteBlock).
  const eligibleAgentReply = useCallback((range: Range) => {
    const n = range.commonAncestorContainer;
    const el = n instanceof Element ? n : n.parentElement;
    return !!el?.closest('[data-reply-author="agent"]');
  }, []);
  const { pos: quotePos, hide: hideQuote } = useQuoteBubble(cardRef, eligibleAgentReply);
  // The body/reply editors reuse the same grow behaviour; the editor mounts only
  // while editing, so the callback ref sizes it to the existing text on the first
  // frame (a long body opens already-expanded, not clipped to the min).
  const editBodyRef = useRef<HTMLTextAreaElement>(null);
  const editBodyGrowRef = useAutoGrow(editBodyRef, editText, 3);

  // Edit targets the *last thing the human wrote* — their last reply, or the
  // feedback body if no one has replied. It's disabled once the agent has the last
  // word: don't rewrite the thread out from under a reply they're acting on (post a
  // new reply instead). So Edit is enabled iff the last message is human-authored.
  const lastReply = fb.replies.at(-1) ?? null;
  const lastAuthor: Author = lastReply?.author ?? fb.author;
  const canEdit = lastAuthor === "human";
  // "Your turn": the agent had the last word (the mirror of canEdit) and it isn't
  // resolved — surfaced as an unread-style dot in the header, and what floats this
  // card into the attention zone at the top of the active list.
  const awaitingYou = needsAttention(fb);
  // Either the body or the last human reply is edited at a time; `editText` is the
  // shared buffer and the bottom action row drives Save/Cancel for whichever is live.
  const isEditing = editing || editingReplyId != null;
  const startEdit = () => {
    if (lastReply && lastReply.author === "human") {
      setEditText(lastReply.body);
      setEditingReplyId(lastReply.id);
    } else {
      setEditText(fb.body);
      setEditing(true);
    }
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditingReplyId(null);
  };

  // Post the composer text (if any) as a plain reply and — for Resolve — flip
  // the status. A reply never carries a status itself; a bare Resolve with an
  // empty composer is a pure status toggle, no filler "Resolved." message.
  const postReply = useMutation({
    mutationFn: async (resolve: boolean) => {
      if (reply.trim()) await api.addReply(fb.id, { author: "human", body: reply });
      if (resolve) await api.editFeedback(fb.id, { status: "resolved" });
    },
    onSuccess: (_data, resolve) => {
      setReply("");
      // Collapse the composer once the reply lands — the thread now shows it, so
      // the open input has nothing left to hold. The action row's "Reply" reopens
      // it for the next one.
      setReplyOpen(false);
      invalidate();
      // Resolving hands focus off to the next still-open item (the parent picks
      // which) — never linger on the just-resolved card or follow it to the
      // Resolved tab.
      if (resolve) onResolved();
    },
  });
  const reopen = useMutation({
    mutationFn: () => api.editFeedback(fb.id, { status: "open" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteFeedback(fb.id),
    onSuccess: invalidate,
  });
  const saveEdit = useMutation({
    mutationFn: async () => {
      if (editingReplyId) await api.editReply(editingReplyId, { body: editText });
      else await api.editFeedback(fb.id, { body: editText });
    },
    onSuccess: () => {
      invalidate();
      cancelEdit();
    },
  });

  // Focus the composer the moment it opens (the human clicked "Reply").
  // preventScroll so the browser doesn't yank the off-screen textarea into view —
  // openReply owns where the panel scrolls to.
  useEffect(() => {
    if (replyOpen) replyRef.current?.focus({ preventScroll: true });
  }, [replyOpen]);

  // Close the ⋯ menu on Escape (mirrors SettingsPopup's popover pattern).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const resolved = fb.status === "resolved";
  // Show the last three replies by default (a version-pinned answer often splits
  // into more than one reply — old vs. new — so keep a little more of the tail in
  // view); the rest fold behind the expander.
  const earlier = fb.replies.length - 3;

  // Reveal the composer, then — only if the last agent reply (the message the
  // human is most likely responding to) is scrolled out of view — bring it to the
  // top of the panel. A reply already on screen shouldn't jump under the user. No
  // agent reply → fall back to the composer, gated the same way.
  const openReply = () => {
    const agentReplies = cardRef.current?.querySelectorAll<HTMLElement>(
      '[data-reply-author="agent"]',
    );
    const lastAgent = agentReplies?.[agentReplies.length - 1] ?? null;
    setReplyOpen(true);
    requestAnimationFrame(() => {
      const target = lastAgent ?? replyRef.current;
      if (!target) return;
      // "Out of the screen" = no part of the target overlaps the scroll pane's
      // visible band. If any of it shows, leave the scroll where it is.
      const pane = scrollParent(cardRef.current);
      if (pane) {
        const t = target.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        if (t.bottom > p.top && t.top < p.bottom) return;
      }
      target.scrollIntoView({ behavior: "smooth", block: lastAgent ? "start" : "nearest" });
    });
  };

  // Drop the selected agent-reply text into the reply draft as a `>` blockquote,
  // open the composer, and land the caret on the blank line after it — ready to
  // respond to the quoted passage. Clears the browser selection so the bubble
  // dismisses and refocus goes cleanly to the textarea.
  const quoteIntoReply = (text: string) => {
    const { text: next, caret } = quoteBlock(reply, text);
    setReply(next);
    setReplyOpen(true);
    hideQuote();
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      const el = replyRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // Outlined (border, no resting fill) so it reads as a button without competing
  // with the filled "Reply" — the ⋯ menu beside it stays a bare ghost trigger.
  const resolveOutline = "border border-neutral-300 dark:border-neutral-700";
  const resolveButton = resolved ? (
    <Button variant="ghost" className={resolveOutline} onClick={() => reopen.mutate()}>
      ↺ Reopen
    </Button>
  ) : (
    <Button
      variant="ghost"
      className={resolveOutline}
      onClick={() => postReply.mutate(true)}
      title="Mark resolved"
    >
      ✓ Resolve
    </Button>
  );

  return (
    <div
      ref={cardRef}
      data-fb-card={fb.id}
      className={cn(
        // Not a floating card — an embedded block flush to the panel. No rounded
        // corners, no box border, no separate fill (it shares the panel's
        // bg-neutral-50/900, which is what used to set the white card apart). Its
        // own p-3 keeps the content off the panel edge; a full-bleed bottom rule
        // (border-b-2) is the only thing between one feedback and the next, so the
        // list reads as one surface rather than a stack of cards. The last block
        // drops the rule so no divider dangles at the end.
        "border-b-2 border-b-neutral-300 border-l-2 border-l-transparent p-3 transition-colors last:border-b-0 dark:border-b-neutral-700",
        // Active feedback: just the amber left rail — no fill (a full-card wash
        // was too loud). The border-l-2 above is always reserved, so activating
        // adds no layout shift. The outdated-anchor state stays on the ⚠ by the
        // file name, not here.
        isActive && "border-l-warning-400 dark:border-l-warning-500",
      )}
    >
      {/* Header: the file:line/general/summary jump (with a stale-anchor ⚠
          prefixing the name) sits at the left for every anchor kind; an optional
          decision word floats to the right. One flex row that truncates, never
          wraps. */}
      <div className="mb-1.5 flex items-center gap-1.5">
        {/* A span (not a button) so the file:line label is selectable to copy;
            the click still jumps, but a click that concluded a drag-selection is
            treated as "copy, don't jump" (clickEndedInSelection). */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a native button would make the label unselectable; the click is a mouse-only convenience (jump) — copying the text is the point */}
        <span
          onClick={() => {
            if (clickEndedInSelection()) return;
            onLocate();
          }}
          className={cn(
            // flex + min-w-0 so the label's `truncate` clips while the ⚠ (a larger
            // glyph) sits on the same baseline as it, keeping the header on one line.
            "flex min-w-0 cursor-pointer items-baseline gap-1 font-mono text-[0.6875rem] transition-colors select-text",
            // Review-level "general" notes get the accent (violet) used elsewhere
            // for general feedback, to set them apart from file/line positions.
            fb.file
              ? "text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400"
              : "text-accent-500 hover:text-accent-600 dark:text-accent-400 dark:hover:text-accent-300",
          )}
          title={fb.file ? `Jump to ${fb.file}` : undefined}
        >
          {fb.anchor === "outdated" && (
            <span
              title="The code this refers to changed — this anchor may be stale."
              className="shrink-0 text-base leading-none text-warning-500 dark:text-warning-400"
            >
              ⚠
            </span>
          )}
          <span className="truncate">{locLabel(fb)}</span>
        </span>
        {/* Agent-authored feedback wears a quiet chip in the agent's voice color
            (the same primary tint as its reply bubbles): this item is the agent
            guiding you, not your own note coming back. */}
        {fb.author === "agent" && (
          <span
            title="Opened by the agent"
            className="shrink-0 rounded bg-primary-100/60 px-1 py-px text-[0.625rem] font-medium text-primary-700 dark:bg-primary-500/15 dark:text-primary-300"
          >
            agent
          </span>
        )}
        {/* "Your turn" dot — an unread-style marker pinned to the header's right
            edge (top-right of the card) when the agent replied last. */}
        {awaitingYou && (
          <span
            title="The agent replied — your turn."
            className="ml-auto flex shrink-0 items-center"
          >
            <span className="block size-2 rounded-full bg-primary-500 dark:bg-primary-400" />
          </span>
        )}
      </div>

      {fb.quote && (
        // A div (not a button) so the quoted code is selectable to copy; a plain
        // click still toggles expand/collapse, but a drag-selection doesn't
        // (clickEndedInSelection). Expand first, then select the hidden lines.
        // biome-ignore lint/a11y/useKeyWithClickEvents: a native button would make the quote unselectable; the click is a mouse-only convenience (expand) — copying the text is the point
        <div
          onClick={() => {
            if (clickEndedInSelection()) return;
            setQuoteExpanded((v) => !v);
          }}
          title={
            quoteExpanded
              ? "Click to collapse · drag to select"
              : "Click to show the full quote · drag to select"
          }
          className={cn(
            // Mono text-xs = the code font in FileView/DiffView, so a quoted line
            // matches the pane it came from.
            "mb-2 block w-full cursor-pointer border-l-2 border-neutral-300 pl-2 text-left font-mono text-xs text-neutral-500 select-text dark:border-neutral-700 dark:text-neutral-400",
            quoteExpanded
              ? "max-h-40 overflow-auto whitespace-pre-wrap break-words"
              : "line-clamp-2 whitespace-pre-wrap break-words",
          )}
        >
          {fb.quote}
        </div>
      )}

      {editing ? (
        <textarea
          ref={editBodyGrowRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editText.trim()) saveEdit.mutate();
            else if (e.key === "Escape") cancelEdit();
          }}
          // biome-ignore lint/a11y/noAutofocus: the editor is opened by an explicit menu click
          autoFocus
          // Full-bleed band (matches the composer / reply box), not a boxed
          // widget: -mx-3 cancels the card's p-3 so it spans edge to edge. Save/Cancel
          // live in the bottom action row. Height auto-grows (no fixed h-*).
          className={cn("-mx-3 w-[calc(100%_+_1.5rem)]", PENDING_INPUT)}
        />
      ) : (
        // The body is the headline of the card — a notch larger than everything
        // else around it — rendered as Markdown.
        <MessageProse
          source={fb.body}
          className="text-sm text-neutral-800 dark:text-neutral-100"
          onJumpRef={(ref) => onJumpRef(ref, fb.patch_seq ?? null)}
        />
      )}

      {fb.replies.length > 0 && (
        // No rule between the body and the thread: a human reply is the same voice
        // as the body, so the two flow together on the same gap rhythm as reply →
        // reply (mt-2.5 == the replies' space-y-2.5). Agent bubbles set themselves
        // apart with their tint; human replies read as continued prose.
        <div className="mt-2.5">
          {/* Fold to the last three replies by default (agent replies can be
              essays); an expander slides the earlier ones open above them.
              Collapsed every render. Spacing is manual (not space-y) so the
              folded Collapse contributes no phantom gap. */}
          {earlier > 0 && (
            <>
              <button
                type="button"
                onClick={() => setRepliesExpanded((v) => !v)}
                className="mb-2.5 flex items-center gap-1 text-[0.6875rem] text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                <FoldTriangle open={repliesExpanded} className="size-2.5" />
                {repliesExpanded
                  ? "hide earlier replies"
                  : `${earlier} earlier ${earlier === 1 ? "reply" : "replies"}`}
              </button>
              <Collapse open={repliesExpanded}>
                <div className="space-y-2.5 pb-2.5">
                  {fb.replies.slice(0, -3).map((rp) => (
                    <ReplyBlock
                      key={rp.id}
                      rp={rp}
                      editing={rp.id === editingReplyId}
                      editValue={editText}
                      onEditChange={setEditText}
                      onEditSave={() => saveEdit.mutate()}
                      onEditCancel={cancelEdit}
                      canSave={editText.trim().length > 0 && !saveEdit.isPending}
                      onLocatePin={onLocatePin}
                      onJumpRef={(ref) => onJumpRef(ref, rp.ref_version ?? null)}
                    />
                  ))}
                </div>
              </Collapse>
            </>
          )}
          <div ref={replyAnim} className="space-y-2.5">
            {fb.replies.slice(-3).map((rp) => (
              <ReplyBlock
                key={rp.id}
                rp={rp}
                editing={rp.id === editingReplyId}
                editValue={editText}
                onEditChange={setEditText}
                onEditSave={() => saveEdit.mutate()}
                onEditCancel={cancelEdit}
                canSave={editText.trim().length > 0 && !saveEdit.isPending}
                onLocatePin={onLocatePin}
                onJumpRef={(ref) => onJumpRef(ref, rp.ref_version ?? null)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Reply composer — collapsed until the human clicks "Reply", then it slides
          open (Collapse). The action row below stays put either way so the card
          layout never shifts. The -mx-3 rides on the Collapse (not the textarea):
          its inner overflow-hidden would clip a margin on the textarea, so the
          wrapper carries the full-bleed and the textarea just fills it. Hidden
          while an edit is in progress so only the editor shows (draft is kept). */}
      <Collapse open={replyOpen && !isEditing} className="-mx-3">
        <textarea
          ref={replyGrowRef}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              reply.trim() &&
              !postReply.isPending
            )
              postReply.mutate(false);
            // Esc closes the box only when it's empty — with text typed, Esc is a
            // no-op so an accidental press can't discard the draft.
            else if (e.key === "Escape" && !reply.trim()) setReplyOpen(false);
          }}
          placeholder={`Reply (${SUBMIT_KEYS} to send)`}
          className={cn("mt-3 w-full", PENDING_INPUT)}
        />
      </Collapse>
      {/* Action row — always present. While editing the body or a reply it becomes
          the editor's Save/Cancel (right-aligned, replacing Reply); otherwise it's
          Resolve then its ⋯ menu on the left, Reply on the right (nearest the
          composer's end). With the composer closed, Reply reveals it; open, Reply
          (or ⌘/Ctrl+Enter) sends. mt-3 both gives the open reply band its 12px
          bottom margin and spaces the row from the thread when closed. */}
      <div className="mt-3 flex items-center gap-1 text-[0.6875rem] [&_button]:cursor-default">
        {isEditing ? (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!editText.trim() || saveEdit.isPending}
              onClick={() => saveEdit.mutate()}
            >
              Save
            </Button>
          </div>
        ) : (
          <>
            {resolveButton}
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
                  <div className="absolute left-0 top-full z-50 mt-1 w-28 overflow-hidden rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
                    {/* Edit the last thing the human wrote (their last reply, else the
                        feedback body). Disabled once the agent replied last — its
                        wording is part of the record they're acting on, so post a new
                        reply instead of editing under them. Delete still works. */}
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => {
                        startEdit();
                        setMenuOpen(false);
                      }}
                      title={
                        canEdit ? undefined : "The agent replied last — post a new reply instead"
                      }
                      className={cn(
                        "block w-full px-3 py-1.5 text-left text-xs",
                        canEdit
                          ? "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                          : "cursor-not-allowed text-neutral-400 dark:text-neutral-600",
                      )}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Delete this feedback and its replies?")) remove.mutate();
                        setMenuOpen(false);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-danger-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            {replyOpen && (
              <button
                type="button"
                aria-label="Discard reply"
                title="Discard reply"
                onClick={() => {
                  setReply("");
                  setReplyOpen(false);
                }}
                className="ml-auto rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-danger-50 hover:text-danger-600 dark:text-neutral-500 dark:hover:bg-danger-950/40 dark:hover:text-danger-400"
              >
                <TrashIcon className="size-4" />
              </button>
            )}
            <Button
              variant="default"
              className={replyOpen ? undefined : "ml-auto"}
              disabled={replyOpen && (!reply.trim() || postReply.isPending)}
              onClick={() => (replyOpen ? postReply.mutate(false) : openReply())}
            >
              {replyOpen ? "Save" : "Reply"}
            </Button>
          </>
        )}
      </div>
      {/* "Quote in reply" bubble for a text selection inside one of this card's
          agent replies. Fixed-positioned (measured off the selection), so it
          escapes the card's overflow. */}
      {quotePos && <QuoteBubble pos={quotePos} label="Quote in reply" onQuote={quoteIntoReply} />}
    </div>
  );
}

// memo'd (with the stable callbacks ReviewView passes) so a scroll-spy activePath
// change in the parent doesn't re-render every card and its mutation hooks.
export const FeedbackPanel = memo(function FeedbackPanel({
  detail,
  pending,
  onDiscardPending,
  onSubmittedPending,
  activeFeedbackId,
  scrollNonce,
  onLocateFeedback,
  onLocatePin,
  onJumpRef,
}: {
  detail: ReviewDetail;
  pending: PendingAnchor | null;
  onDiscardPending: () => void;
  onSubmittedPending: () => void;
  activeFeedbackId: string | null;
  // Bumped on each locate so re-selecting the already-active feedback re-scrolls.
  scrollNonce: number;
  // null clears the active feedback (focus nothing).
  onLocateFeedback: (fb: FeedbackWithReplies | null) => void;
  onLocatePin: (patchSeq: number, file: string | null, line: number | null) => void;
  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message. The
  // second arg is the message's pinned version — a reply's `ref_version` (round /
  // snapshot captured at post time), or a feedback body's own round.
  onJumpRef: (ref: MessageRef, version: number | null) => void;
}) {
  const qc = useQueryClient();
  const { copied, failed, copy } = useCopyPrompt(detail.id);
  // Mirror the server's unsent predicate (prompt.ts hasUnsentContent): feedback
  // has content the agent hasn't seen when it was never sent (and is still
  // open), or a human reply / undelivered status flip (a bare Resolve/Reopen)
  // arrived after the last hand-off. Gates Copy/Submit — there's nothing to
  // send once everything's delivered (a fresh reply/feedback/decision
  // re-enables it live).
  const hasUnsent = detail.feedback.some((f) =>
    f.sent_at == null
      ? f.status === "open"
      : f.replies.some((r) => r.author === "human" && r.sent_at == null) || f.status_unsent,
  );
  // The general note's text lives in the browser draft store (persisted, lights the
  // pill); `generalOpen` is just the local "is the composer showing" bit. It's kept
  // showing while there's text too (below), so it survives being hidden behind an
  // anchored draft and restores on reload.
  const [generalOpen, setGeneralOpen] = useState(false);
  const generalText = useGeneralDraft(detail.id);
  const showGeneral = generalOpen || generalText.trim() !== "";
  // A just-created feedback rides in local state so the new card appears the
  // instant the composer clears — no wait for the refetch — which lets auto-animate
  // play its enter animation on it right away. Dropped once the real review row
  // (SSE/refetch) carries the same id, so the card swaps to the server copy in
  // place — same key, no remount.
  const [optimistic, setOptimistic] = useState<FeedbackWithReplies | null>(null);

  // The composer region sits at the *bottom* of the list; reveal it when a new
  // anchor selection or the general note opens it (a scrolled-down user needs it
  // brought into view). The anchor key is its primitives so a live SSE refetch
  // (unchanged anchor) doesn't re-scroll.
  const composerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The list and reply thread animate via auto-animate plugins; the composer opens
  // and closes with <Collapse> (a height slide) instead — a CSS transition isn't
  // subject to auto-animate's offscreen-skip, which swallowed the composer's entry
  // when it mounted below the fold.
  const [listAnim] = useAutoAnimate<HTMLDivElement>(feedbackAnimation);
  const pendingKey = pending
    ? `${pending.file}:${pending.side}:${pending.lineStart}:${pending.lineEnd}:${pending.patchSeq ?? ""}`
    : null;
  // Reveal the composer as it opens. A one-shot scrollIntoView fires while the
  // <Collapse> is still at ~0px (grid-rows mid-slide), so it scrolls to a
  // zero-height box that then expands *downward* past the fold — the input ends up
  // cut off on a long list. Instead, track the growing element for the length of
  // the slide, nudging the pane down whenever the composer's bottom (plus a little
  // breathing room) falls below the pane, so it lands fully in view. Only scrolls
  // when there's overflow below, so an already-visible composer stays put.
  useEffect(() => {
    if (!(pendingKey || generalOpen)) return;
    const pane = listRef.current;
    const el = composerRef.current;
    if (!pane || !el) return;
    const reduce = prefersReduced();
    const startedAt = performance.now();
    let raf = 0;
    const keepInView = () => {
      const overflowBelow =
        el.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom + 12;
      if (overflowBelow > 0) pane.scrollTop += overflowBelow;
      // Keep pace with the Collapse height slide (200ms); stop once it has settled.
      if (!reduce && performance.now() - startedAt < 240) raf = requestAnimationFrame(keepInView);
    };
    raf = requestAnimationFrame(keepInView);
    return () => cancelAnimationFrame(raf);
  }, [pendingKey, generalOpen]);

  // Cancel/✕ discards the general note (clears the persisted draft) and closes it.
  const closeGeneral = () => {
    clearGeneral(detail.id);
    setGeneralOpen(false);
  };

  // The composer region shows one composer at a time: a pending anchor wins it, so
  // a newly-picked anchor hides the general note — but hide-don't-discard: its text
  // stays persisted (`showGeneral` brings it back once the anchor is gone). Keyed on
  // `pending` (stable per-draft), so it fires only when a genuinely new anchor
  // arrives, not on every keystroke.
  useEffect(() => {
    if (pending) setGeneralOpen(false);
  }, [pending]);
  const [tab, setTab] = useState<"active" | "resolved">("active");

  // Unsaved composers (the anchored draft, the general note, and any in-progress
  // reply) live only in the browser — none has reached the server, so none can be
  // handed to the agent. The count drives the header pill and gates the hand-off
  // so nothing unsaved is silently forgotten. A fresh keystroke that
  // crosses empty↔non-empty flips the count (and only then re-renders the panel).
  const draftCount = useDraftCount(detail.id);
  const unsavedDraft = draftCount > 0;

  // Reap reply drafts whose feedback is gone (deleted here or by another client) so
  // an orphan can't keep the pill lit / hand-off blocked with no card to clear it.
  // Keyed on the id set (a joined string) so it only runs when membership changes.
  const feedbackIdsKey = detail.feedback.map((f) => f.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail.feedback is captured via feedbackIdsKey; re-run only when the id set changes
  useEffect(() => {
    pruneReplyDrafts(
      detail.id,
      detail.feedback.map((f) => f.id),
    );
  }, [detail.id, feedbackIdsKey]);

  // Resolved feedback lives in its own tab so the working set stays focused.
  const resolved = detail.feedback.filter((f) => f.status === "resolved");
  // Fold the optimistic card (if its real row hasn't landed) onto the end of the
  // active list — feedback is created_at ASC, so a new one sorts last, right above
  // the bottom composer it was typed in. `optimistic && …` narrows it non-null.
  const activeReal = detail.feedback.filter((f) => f.status !== "resolved");
  const active =
    optimistic && !detail.feedback.some((f) => f.id === optimistic.id)
      ? [...activeReal, optimistic]
      : activeReal;
  // Attention-first ordering within the Active tab: cards where the agent had the
  // last word ("your turn") float above the rest, each group keeping its created_at
  // order — a *stable* partition, so a card moves only when its turn actually flips
  // (reply/resolve sinks it; an agent reply raises it), which the list's
  // auto-animate then FLIPs. Nothing is hidden: the two tabs stay the clean
  // active/resolved split — this only ranks within Active. A "no response needed"
  // divider (below) sits between the groups when both are non-empty.
  const attention = active.filter(needsAttention);
  const rest = active.filter((f) => !needsAttention(f));
  const ordered = [...attention, ...rest];

  // Once the real review row for the optimistic card lands, drop the local copy;
  // the server row takes its slot under the same key (no remount, no flicker).
  useEffect(() => {
    if (optimistic && detail.feedback.some((f) => f.id === optimistic.id)) setOptimistic(null);
  }, [detail.feedback, optimistic]);

  // A single highlight pill that slides (translateX + width) to the active filter
  // tab. The two pills are different, count-dependent widths, so measure the
  // active one's box and drive an absolutely-positioned highlight to it — a CSS
  // transition on transform/width then eases it across. Re-measure when the tab or
  // either count (which changes a label's width) changes.
  const tabRefs = useRef<Partial<Record<"active" | "resolved", HTMLButtonElement | null>>>({});
  const [tabHi, setTabHi] = useState<{ left: number; top: number; w: number; h: number } | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counts aren't read in the effect but change each label's width, so re-measure when either changes
  useLayoutEffect(() => {
    const el = tabRefs.current[tab];
    if (el) {
      setTabHi({ left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    }
  }, [tab, active.length, resolved.length]);

  // Resolving a card advances focus to the next still-open item so a top-down
  // pass keeps moving, instead of trailing the resolved item over to the
  // Resolved tab. Take the item that slides into the resolved one's slot; if it
  // was last, fall back to the new last; if nothing's left, focus nothing.
  // Computed off this render's pre-resolve `ordered` list (the displayed,
  // attention-first order — which still includes the item being resolved).
  const advanceAfterResolve = (resolvedId: string) => {
    const idx = ordered.findIndex((f) => f.id === resolvedId);
    const remaining = ordered.filter((f) => f.id !== resolvedId);
    onLocateFeedback(remaining.length === 0 ? null : (remaining[idx] ?? remaining.at(-1)!));
  };

  // Commit a freshly-created feedback: drop it in as the optimistic card (so it
  // appears the instant the composer clears) on the active tab. auto-animate then
  // plays the enter animation (feedbackAnimation) on the new card. The real row
  // reconciles in behind the same id.
  const commitCreated = (fb: Feedback, clearComposer: () => void) => {
    const row: FeedbackWithReplies = { ...fb, replies: [] };
    setOptimistic(row);
    setTab("active");
    clearComposer();
    // Focus the just-saved feedback: select it (amber rail) and scroll its card
    // into view — the effect keyed on activeFeedbackId brings the new card up, and
    // for an anchored note the file pane jumps to its line. A general note has no
    // file, so it just lights the card.
    onLocateFeedback(row);
    // Reconcile with server truth (derived anchor/sha fields, sent_at); the write
    // also SSE-invalidates every client, so this is just determinism for us.
    qc.invalidateQueries({ queryKey: ["review", detail.id] });
  };

  // When a feedback becomes active — notably by clicking its highlighted region
  // in the file pane — reveal its tab, then scroll its card into view. Split in
  // two so the scroll runs after a tab switch has rendered the card; keyed on
  // scrollNonce too so re-selecting the already-active feedback re-scrolls.
  const activeFb = detail.feedback.find((f) => f.id === activeFeedbackId);
  const activeResolved = activeFb?.status === "resolved";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the active feedback's id, not the activeFb object — the object gets a new reference on every SSE detail refetch, and depending on it would yank a user browsing the Resolved tab back to Active on a background reply. scrollNonce is an intentional re-trigger dep.
  useEffect(() => {
    if (activeFb) setTab(activeResolved ? "resolved" : "active");
  }, [activeFeedbackId, activeResolved, scrollNonce]);
  // Bring the active card into view — but only when it's actually off-screen, so a
  // card the user can already see never gets yanked. That single guard also means
  // clicking a card's own file:line path (which activates it) doesn't scroll the
  // card, since the card the click landed on is by definition already visible —
  // only the file pane jumps. "Out of view" = no part of the card overlaps the
  // scroll pane's visible band (same idiom as openReply); `block:"start"` then puts
  // its top at the top of the panel. Re-run on the active-list membership too:
  // resolving advances focus to the next card *before* the resolved one leaves the
  // list (its refetch is still in flight), so the card above it later drops out and
  // the target shifts up — a scroll fired now would land stale. Keying on
  // `activeIds` re-scrolls once that reflow lands, so the target ends up aligned.
  const activeIds = ordered.map((f) => f.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run after a tab switch or list reflow (re)renders the card, and on scrollNonce
  useEffect(() => {
    if (!activeFeedbackId) return;
    const pane = listRef.current;
    const card = pane?.querySelector<HTMLElement>(
      `[data-fb-card="${CSS.escape(activeFeedbackId)}"]`,
    );
    if (!pane || !card) return;
    const c = card.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    if (c.bottom > p.top && c.top < p.bottom) return; // any part visible → leave it
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeFeedbackId, scrollNonce, tab, activeIds]);

  // Live presence of `r3 watch` clients. When an agent is watching, the
  // human submits straight to it instead of copy-pasting a prompt.
  const { data: watchersData } = useQuery({
    queryKey: ["watchers", detail.id],
    queryFn: () => api.watchers(detail.id),
    refetchInterval: 30000, // safety net beyond the SSE watchers-changed event
    refetchIntervalInBackground: true, // …that also fires when the tab is hidden
  });
  const watchers = watchersData?.watchers ?? [];
  const watching = watchers.length > 0;

  const [sent, setSent] = useState(false);
  const submit = useMutation({
    mutationFn: () => api.submit(detail.id),
    onSuccess: () => {
      // Optimistically drain the watcher list so the button flips to "Copy
      // prompt" the instant we submit. `r3 watch` exits on the `submitted`
      // broadcast, but its refetch lags ~1s. The next watchers-changed
      // invalidation (or the 20s interval) overwrites this with server truth,
      // so a fresh `r3 watch` re-shows the Submit button on its own.
      qc.setQueryData<WatchersResponse>(["watchers", detail.id], { watchers: [] });
      setSent(true);
      setTimeout(() => setSent(false), 1800);
    },
  });

  // The composer (one at a time: the anchored draft, else the general note). It
  // opens/closes with <Collapse>. Collapse needs its content present to animate the
  // *close*, but NewFeedback/GeneralFeedback unmount the instant pending/showGeneral
  // clears — so hold the last content across the close (matching Collapse's 200ms),
  // then drop it. `heldComposer` is written during render (latest-value pattern).
  const composerOpen = pending != null || showGeneral;
  const composerContent = pending ? (
    <NewFeedback
      reviewId={detail.id}
      pending={pending}
      onDiscard={onDiscardPending}
      onCommit={(fb) => commitCreated(fb, onSubmittedPending)}
    />
  ) : showGeneral ? (
    <GeneralFeedback
      reviewId={detail.id}
      onClose={closeGeneral}
      onCommit={(fb) => commitCreated(fb, closeGeneral)}
    />
  ) : null;
  const heldComposer = useRef<ReactNode>(null);
  if (composerContent) heldComposer.current = composerContent;
  // Drop the held content once the close finishes. `heldComposer.current` persists
  // synchronously (a ref), so the first closing frame already has content to slide —
  // this only forces the re-render that unmounts it (and its window key listener)
  // after the collapse, keyed on composerOpen so a reopen mid-close cancels it.
  const [, dropHeld] = useState(0);
  useEffect(() => {
    if (composerOpen || !heldComposer.current) return;
    const t = setTimeout(() => {
      heldComposer.current = null;
      dropHeld((n) => n + 1);
    }, 220);
    return () => clearTimeout(t);
  }, [composerOpen]);

  return (
    <div className="flex h-full flex-col">
      {/* The title/CTA row and the filter-pills row share one padded flex box:
          gap-2 between the rows and padding on the parent (not per-row py) keep
          their spacing consistent, and the border sits under the whole header.
          The header's heights are its own — deliberately NOT matched to the file
          pane's bars across the split (equal heights there read as one bar). */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950">
        <div className="flex items-center justify-between gap-2">
          {/* Title + the unsaved-draft pill. The pill rides right of the title (not
              down in the pills row) so it reads as a status on "Feedback" itself and
              stays visible even with no feedback/tabs yet. It counts every unsaved
              surface — the anchored draft, the general note, and any in-progress
              reply — since none has reached the server. */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-base font-semibold">Feedback</span>
            {unsavedDraft && (
              <span
                title="Unsaved draft — add/post it to save, or discard it. It isn't sent to the agent until then."
                className="shrink-0 rounded-full bg-warning-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-warning-700 dark:bg-warning-950/60 dark:text-warning-300"
              >
                ✎ {draftCount === 1 ? "unsaved draft" : `${draftCount} unsaved drafts`}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Add a review-level note not tied to any line. The composer opens at
                the bottom of the list; a compact icon here replaces the old dashed
                "+ General feedback" button that used to sit in the list. Opening it
                discards a pending anchored draft (one composer at a time) and jumps
                to the active tab, where composing happens. */}
            <button
              type="button"
              aria-label="Add general feedback"
              title="Add general feedback — a note about the review as a whole, not tied to any line"
              onClick={() => {
                onDiscardPending();
                setTab("active");
                setGeneralOpen(true);
              }}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <CommentPlusIcon className="size-4" />
            </button>
            {/* The title lives on a wrapping span, not just the Button: a disabled
              Button has `pointer-events-none`, so its own `title` never fires on
              hover. The span stays hoverable and surfaces *why* the hand-off is
              disabled. */}
            {watching ? (
              <span
                className="inline-flex shrink-0"
                title={
                  unsavedDraft
                    ? "Add, post, or discard your unsaved draft(s) first"
                    : !hasUnsent
                      ? "Everything has been sent — a new reply or feedback re-enables this"
                      : "Send the feedback to the watching agent"
                }
              >
                <Button
                  variant="primary"
                  onClick={() => submit.mutate()}
                  disabled={!hasUnsent || submit.isPending || unsavedDraft}
                >
                  Submit
                </Button>
              </span>
            ) : (
              <span
                className="inline-flex shrink-0"
                title={
                  unsavedDraft
                    ? "Add, post, or discard your unsaved draft(s) first"
                    : !hasUnsent
                      ? "Everything has been sent — a new reply or feedback re-enables this"
                      : undefined
                }
              >
                <Button
                  variant="primary"
                  onClick={() => copy()}
                  disabled={!hasUnsent || unsavedDraft}
                >
                  {sent ? "Sent ✓" : copied ? "Copied!" : failed ? "Copy failed" : "Copy prompt"}
                </Button>
              </span>
            )}
          </div>
        </div>
        {(detail.feedback.length > 0 || watching) && (
          // Fixed height (the pills' 1.25rem) so this secondary row never changes
          // the header's height. Everything here is ≤ 1.25rem, so the min-height
          // simply pins the row and its contents just center within it. (The
          // unsaved-draft chip now lives up in the title row, not here.)
          <div className="flex min-h-5 items-center justify-between gap-2">
            {/* Left: the Active/Resolved filter pills — only when there's feedback.
              When there isn't, this bar still draws so the watching indicator on
              the right has a home. */}
            {detail.feedback.length > 0 ? (
              <div className="relative flex gap-1">
                {/* The bright fill lives on this one element and slides between the
                  pills; the buttons carry only text color now. The horizontal move
                  is a `translateX` (compositor-thread transform), not `left`
                  (main-thread layout), so the slide stays smooth even while the
                  panel is busy re-rendering cards / handling SSE. */}
                {tabHi && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 rounded bg-neutral-200 transition-[transform,width] duration-150 ease-out will-change-transform motion-reduce:transition-none dark:bg-neutral-700"
                    style={{
                      top: tabHi.top,
                      width: tabHi.w,
                      height: tabHi.h,
                      transform: `translateX(${tabHi.left}px)`,
                    }}
                  />
                )}
                {(
                  [
                    ["active", "Active", active.length],
                    ["resolved", "Resolved", resolved.length],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    ref={(el) => {
                      tabRefs.current[id] = el;
                    }}
                    type="button"
                    onClick={() => setTab(id)}
                    className={cn(
                      "relative z-10 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                      tab === id
                        ? "text-neutral-900 dark:text-neutral-100"
                        : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200",
                    )}
                  >
                    {label} <span className="font-normal text-neutral-400">· {count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span />
            )}
            {/* Right: the live watching indicator. It lives on this bar (rather than
              a standing header row) so the watching dot survives the zero-feedback
              setup state — the agent runs `r3 watch` before any feedback exists. */}
            {watching && (
              <div className="flex min-w-0 items-center gap-2 text-[0.6875rem]">
                <span
                  className="flex min-w-0 items-center gap-1.5 text-primary-700 dark:text-primary-400"
                  title={watchersTitle(watchers)}
                >
                  {/* A steady dot, not a pulsing one — the blink was distracting. */}
                  <span className="h-2 w-2 shrink-0 rounded-full bg-primary-500" />
                  <span className="truncate">{watchersLabel(watchers)} watching</span>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      {/* No padding on the scroll container: the composer region and feedback
          blocks are full-bleed (each owns its p-3 + divider); the empty state
          restores its own padding. */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {/* The feedback list. Re-keyed on `tab` so switching filters remounts it
            and replays the fade-slide (main.css); the composer region below sits
            outside it so an unsaved draft/note persists across tabs. The auto-animate
            (listAnim) ref goes on an inner container that holds *only* the cards, so
            it animates cards in/out + reflow *within* a tab — the tab-switch itself
            stays the remount fade-slide. The empty-state hints sit *outside* that
            container: they're not list items, so auto-animate mustn't slide them
            off-screen when the first card lands. */}
        <div key={tab} className="relative r3-fade-slide-in">
          {tab === "active" ? (
            <>
              {/* Absolute + out of flow: when the last card is removed and this hint
                  appears, it must not push the (auto-animate-pinned) exiting card
                  down — that reflow was the card's diagonal exit. Always mounted and
                  toggled via `.is-visible` (not conditionally rendered) so it can
                  fade *in* slowly (1s) as the list empties yet fade *out* quickly
                  when a card/composer arrives (asymmetric durations in main.css);
                  pointer-events-none so the invisible overlay never eats a click on
                  the first card. */}
              <p
                className={cn(
                  "r3-hint pointer-events-none absolute inset-x-0 top-0 px-4 py-6 text-center text-xs text-neutral-400",
                  active.length === 0 && !pending && !showGeneral && "is-visible",
                )}
              >
                Select text — or click a line number — in the diff or files to leave feedback.
              </p>
              <div ref={listAnim}>
                {attention.map((fb) => (
                  <FeedbackCard
                    key={fb.id}
                    fb={fb}
                    reviewId={detail.id}
                    isActive={fb.id === activeFeedbackId}
                    onLocate={() => onLocateFeedback(fb)}
                    onLocatePin={onLocatePin}
                    onResolved={() => advanceAfterResolve(fb.id)}
                    onJumpRef={onJumpRef}
                  />
                ))}
                {/* Zone divider between the "your turn" cards and the rest — only
                    when both groups exist. Fades in place (not slid off) via the
                    data-zone-divider case in feedbackAnimation. The label speaks
                    only to the response axis ("no response needed"): the group
                    below is heterogeneous (your own unsent notes, items sent and
                    awaiting the agent, threads you already replied to), so it is
                    NOT uniformly "waiting on agent" — the one true thing is that no
                    agent message there is sitting unanswered by you. */}
                {attention.length > 0 && rest.length > 0 && (
                  // The last attention card's own border-b-2 draws the separating
                  // line; this is just the section label below it — no flanking
                  // rules, so the two don't stack into a double line.
                  <div
                    key="zone-divider"
                    data-zone-divider
                    className="select-none px-3 py-1.5 text-center text-[0.625rem] font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500"
                  >
                    no response needed
                  </div>
                )}
                {rest.map((fb) => (
                  <FeedbackCard
                    key={fb.id}
                    fb={fb}
                    reviewId={detail.id}
                    isActive={fb.id === activeFeedbackId}
                    onLocate={() => onLocateFeedback(fb)}
                    onLocatePin={onLocatePin}
                    onResolved={() => advanceAfterResolve(fb.id)}
                    onJumpRef={onJumpRef}
                  />
                ))}
              </div>
            </>
          ) : resolved.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-neutral-400">
              No resolved feedback yet.
            </p>
          ) : (
            <div ref={listAnim}>
              {resolved.map((fb) => (
                <FeedbackCard
                  key={fb.id}
                  fb={fb}
                  reviewId={detail.id}
                  isActive={fb.id === activeFeedbackId}
                  onLocate={() => onLocateFeedback(fb)}
                  onLocatePin={onLocatePin}
                  // A resolved card has no Resolve button, so this never fires.
                  onResolved={() => {}}
                  onJumpRef={onJumpRef}
                />
              ))}
            </div>
          )}
        </div>

        {/* Composer region, pinned to the *bottom* of the list — composing happens
            below the existing feedback, so a newly-added card lands right where you
            were typing (feedback appends, created_at ASC). At most one composer is
            open: the anchored draft OR the general note (opened from the header's
            + button, which discards a pending anchored draft; a newly-picked anchor
            hides the general note but keeps its text — `showGeneral` brings it back).
            It opens/closes with <Collapse> (height slide); a divider brackets it
            top+bottom while open. Renders composerContent while open, then the held
            copy through the close so the collapse has something to slide away. */}
        <div ref={composerRef}>
          <Collapse
            open={composerOpen}
            className={cn(composerOpen && "border-y-2 border-neutral-300 dark:border-neutral-700")}
          >
            {composerOpen ? composerContent : heldComposer.current}
          </Collapse>
        </div>

        {/* Scroll safe-space: a trailing spacer sized to 38% of the pane, so the
            last block can be scrolled up toward the middle once the list overflows
            — the panel's "scroll past the end". As a % of the (flex-definite)
            scroll pane it adds no scrollbar to a short list: the content must
            already exceed ~62% of the pane before this makes it scrollable. */}
        <div aria-hidden="true" className="h-[38%]" />
      </div>
    </div>
  );
});
