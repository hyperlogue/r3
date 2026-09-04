import type { AutoAnimationPlugin } from "@formkit/auto-animate";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api } from "../api.ts";
import { copyText } from "../clipboard.ts";
import {
  clearGeneral,
  pruneReplyDrafts,
  setDraftAnchor,
  setDraftText,
  setGeneralText,
  useDraftCount,
  useDraftText,
  useGeneralDraft,
  useHasGeneralText,
} from "../drafts.ts";
import { apiErrorText, shortSession } from "../format.ts";
import {
  isInteractiveTarget,
  isKeyboardFocused,
  isTextEntry,
  keysSuspended,
  useKeyBindings,
} from "../keys.ts";
import type { MessageRef } from "../markdown.ts";
import type { AnchorRect, PendingAnchor } from "../selection.ts";
import type {
  FeedbackClaim,
  FeedbackWithReplies,
  ReviewDetail,
  WatcherInfo,
  WatchersResponse,
} from "../types.ts";
import { hasUnsentContent, SUMMARY_FILE } from "../types.ts";
import {
  Button,
  Collapse,
  CommentPlusIcon,
  CopyMeta,
  cn,
  FoldChevrons,
  prefersReduced,
  useCopyFlash,
} from "../ui.tsx";
import { useOptimisticPatch } from "../useOptimistic.ts";
import {
  type CardCommand,
  FeedbackCard,
  needsAttention,
  summaryTargetLabel,
} from "./FeedbackCard.tsx";
import {
  CoarsePointerContext,
  MessageEditor,
  SUBMIT_KEYS,
  usePlaceholder,
} from "./MessageEditor.tsx";

// Feedback cards: a new card fades in fast then glides up into place; a removed card
// slides straight out to the right, off the panel (clipped by listRef's
// overflow-x-hidden), fading as it goes; the rest FLIP into their new slots.
const feedbackAnimation: AutoAnimationPlugin = (el, action, a, b) => {
  const reduce = prefersReduced();
  if (action === "add") {
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

// Both presence badges read the same way: the session id that is doing the work,
// then what it is doing. They return the two halves separately so the id can be
// its own click-to-copy token — it is the handle you paste into `r3 list --meta
// session=…`, an agent list, or a message to the session, and a truncated one you
// can only re-type is no handle at all. `session: null` means there is no single id to
// copy (several agents hold claims), so that badge stays plain text.
type PresenceLabel = { session: string | null; suffix: string };

// One watcher (or empty). Names the holder rather than counting a crowd.
function watchersLabel(watchers: WatcherInfo[]): PresenceLabel {
  return { session: watchers[0]?.session ?? null, suffix: "watching" };
}
function watchersTitle(watchers: WatcherInfo[]): string {
  return `watching: ${watchers.map((w) => (w.agentId ? `${w.session} (${w.agentId})` : w.session)).join(", ")}`;
}

function claimsLabel(claims: FeedbackClaim[]): PresenceLabel {
  const sessions = [...new Set(claims.map((claim) => claim.session))];
  if (sessions.length === 1)
    return {
      session: sessions[0],
      suffix: claims.length === 1 ? "working" : `working on ${claims.length}`,
    };
  return { session: null, suffix: `${sessions.length} agents working` };
}

// The text of one presence badge: a copyable short session id followed by what
// it's up to, or just the summary when no single session owns it.
function PresenceText({ label }: { label: PresenceLabel }) {
  if (!label.session) return <span className="truncate">{label.suffix}</span>;
  return (
    <span className="truncate">
      <CopyMeta value={label.session} hint={`Copy session: ${label.session}`}>
        {shortSession(label.session)}
      </CopyMeta>{" "}
      {label.suffix}
    </span>
  );
}
function claimsTitle(claims: FeedbackClaim[]): string {
  return claims
    .map(
      (claim) =>
        `${claim.session}${claim.agentId ? ` (${claim.agentId})` : ""} working on ${claim.feedback_id}`,
    )
    .join("\n");
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
  error,
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
  // A failed add has no other surface — the mutation errors silently and the
  // composer just sits there otherwise; show the server's message under the input.
  error?: string | null;
  onClose: () => void;
  // Tags the composer's textarea (data-anchored-composer) so a "Quote in note"
  // click can find + focus it from ReviewView (a different subtree).
  anchored?: boolean;
}) {
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
      {/* Full-bleed to the block's edges (-mx-3 cancels the p-3). Esc is owned by
          useComposerKeys (empty cancels, text blurs) — not the textarea. */}
      <MessageEditor
        textareaRef={textareaRef}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
        autoFocus={autoFocus}
        anchored={anchored}
        className="-mx-3 w-[calc(100%_+_1.5rem)]"
      />
      {error && (
        <div className="mt-1 text-[0.6875rem] text-danger-600 dark:text-danger-400">{error}</div>
      )}
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
// hijack its keys (e.g. Esc closing the settings popup).
//
// `keyToFocus` (only the non-autofocused composer, which opens from a pointer
// gesture in the file pane) lets Space or forward-Tab pull focus into the input, so
// the note you just anchored is one keystroke away without reaching back for the
// mouse. Neither key is in KEYMAP: like Esc, they stay owned by whatever is open —
// KEYMAP binds only letters and punctuation, precisely so a focused control keeps
// its own Space/Enter.
//
// Stands down for a KEYBOARD-focused target (`isKeyboardFocused`), not every
// interactive one: click-stranded focus has no ring and would eat Space by
// re-firing that button; a tabbed-to control keeps Space/Tab. Nothing is swallowed
// when the key can't act (no textarea, or the phone tier's closed `inert` sheet).
function useComposerKeys(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onCancel: () => void,
  keyToFocus = false,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The shortcuts sheet is up and owns these keys (Esc closes it). Both
      // listeners are on window, so without this one press would close the sheet
      // AND discard the composer sitting behind it.
      if (keysSuspended()) return;
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
      if (!keyToFocus || e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Forward Tab only — Shift+Tab still navigates backward.
      const isSpace = e.key === " " || e.code === "Space";
      if (!isSpace && !(e.key === "Tab" && !e.shiftKey)) return;
      if (isTextEntry(active) || isKeyboardFocused(active)) return;
      if (!ta || ta.closest("[inert]")) return;
      e.preventDefault(); // Space would re-fire a stranded button; Tab would leave
      ta.focus();
      // Caret at the end: a persisted draft is resumed, not overwritten.
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, textareaRef, keyToFocus]);
}

// A free-form feedback item not tied to any file or line (review-level note). Its
// text lives in the browser draft store (drafts.ts), so it persists across a
// review-switch/reload and lights the hand-off pill — same as the anchored draft.
function GeneralFeedback({
  reviewId,
  onClose,
  onSubmit,
  submitPending,
  submitError,
}: {
  reviewId: string;
  // onClose discards the general note (clears the draft + closes). The panel owns
  // the mutation (optimistic insert + rollback + reconcile) so it survives this
  // composer unmounting the instant the note is submitted — onSubmit just hands it
  // the note text.
  onClose: () => void;
  onSubmit: (body: string) => void;
  submitPending: boolean;
  submitError: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const value = useGeneralDraft(reviewId);
  // Same keyboard behavior as the anchored composer: autofocus (below) + Esc
  // cancels when empty. onClose already clears the draft + closes. No
  // Space/Tab-to-focus — the input is autofocused, so Space types a space and Tab
  // moves focus onward, both normally.
  useComposerKeys(textareaRef, onClose);
  return (
    <ComposerBlock
      label="General feedback"
      textareaRef={textareaRef}
      value={value}
      onChange={(t) => setGeneralText(reviewId, t)}
      placeholder={usePlaceholder(
        "A note about the review as a whole…",
        `${SUBMIT_KEYS} to add · Esc to cancel`,
      )}
      autoFocus
      submitLabel="Save"
      onSubmit={() => onSubmit(value)}
      submitPending={submitPending}
      error={submitError}
      onClose={onClose}
    />
  );
}

function NewFeedback({
  reviewId,
  pending,
  onDiscard,
  onSubmit,
  submitPending,
  submitError,
}: {
  reviewId: string;
  pending: PendingAnchor;
  onDiscard: () => void;
  // The panel owns the mutation (optimistic insert + rollback + reconcile) so it
  // survives this composer unmounting the instant the note is submitted — onSubmit
  // just hands it the note text. onDiscard stays for Cancel/✕.
  onSubmit: (body: string) => void;
  submitPending: boolean;
  submitError: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The anchored note lives in the browser draft store, keyed to this review.
  const draftText = useDraftText(reviewId);

  // A whole-file anchor (a real path, no line span) only comes from the file
  // header's feedback button — a deliberate composer-open click, like "add general
  // feedback", so focus the input immediately (below). A selection/gutter/summary
  // anchor is a text gesture in the file pane; autofocusing there would yank focus
  // off the code (and collapse the selection you just made), so those open unfocused
  // — you click into the box, or press Space/Tab (below), which is the same reach
  // without leaving the keyboard.
  const autoFocusInput = pending.file !== SUMMARY_FILE && pending.lineStart == null;

  // Esc-cancels-when-empty (shared with the general note); Space/Tab-to-focus only
  // for the non-autofocused composer, so an autofocused input types spaces.
  useComposerKeys(textareaRef, onDiscard, !autoFocusInput);

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
      placeholder={usePlaceholder(
        "Leave feedback…",
        `${autoFocusInput ? "" : "Space/Tab to focus · "}${SUBMIT_KEYS} to add · Esc to cancel`,
      )}
      autoFocus={autoFocusInput}
      submitLabel="Add feedback"
      onSubmit={() => onSubmit(draftText)}
      submitPending={submitPending}
      error={submitError}
      anchored
      onClose={onDiscard}
    />
  );
}

export const RAIL_WIDTH = "2rem";

// The collapsed dock — the FileBrowser rail mirrored across the pane: the same
// FoldChevrons toggle (pointing the way it opens), the same uppercase vertical
// "<name> · <count>" label, the whole rail as the hit target. Symmetry is the
// point; two different fold affordances on the two edges of one pane would be two
// things to learn for one idea.
//
// It carries one thing FileBrowser has no equivalent for: a status glyph, because
// folding the panel away must not cost you the "something needs you" signal that
// is the only reason to expand it in a hurry.
function CollapsedRail({
  openCount,
  unsaved,
  unsent,
  live,
  onExpand,
}: {
  openCount: number;
  // An unsaved browser draft — it blocks the hand-off, and with the panel folded
  // away this ✎ is the only thing on screen that says why.
  unsaved: boolean;
  // Server-side content the agent hasn't been handed yet (hasUnsentContent).
  unsent: boolean;
  // An agent is watching or holds a claim — the same primary dot the expanded
  // header shows, minus the label there's no room for.
  live: boolean;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title="Show feedback"
      aria-label={`Show feedback — ${openCount} open`}
      className="flex min-h-0 w-full flex-1 cursor-pointer flex-col items-center gap-2 py-2 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
    >
      <FoldChevrons dir="left" />
      {/* One glyph at most, in the order that decides what to do next: an unsaved
          draft is yours to finish, undelivered content is the hand-off waiting,
          live presence is just context. */}
      {unsaved ? (
        <span
          title="Unsaved draft — expand the panel to add or discard it"
          className="text-[0.625rem] leading-none text-warning-600 dark:text-warning-400"
        >
          ✎
        </span>
      ) : unsent ? (
        <span
          title="Feedback the agent hasn't been handed yet"
          className="size-1.5 rounded-full bg-primary-500"
        />
      ) : live ? (
        <span
          title="An agent is watching or working"
          className="size-1.5 rounded-full bg-primary-500/50"
        />
      ) : null}
      <span className="text-[0.625rem] font-semibold tracking-wide text-neutral-400 uppercase [writing-mode:vertical-rl]">
        Feedback · {openCount}
      </span>
    </button>
  );
}

// The composer, brought to the gesture. With the panel folded to its rail there
// is no list to open a composer at the bottom of, so the anchored note floats next
// to the code it is about (ReviewView measures the selection and hands over
// `at`) — which is the whole point of collapsing: annotate without giving the
// width back.
//
// Portalled to <body> so the scroll pane's overflow can't clip it, fixed and
// clamped into the viewport, and deliberately NOT scroll-tracking: you are typing
// into it, so it stays where it opened rather than chasing the code out from
// under the caret. It re-clamps as the textarea auto-grows, so a long note can't
// grow off the bottom of the screen.
function FloatingComposer({ at, children }: { at: AnchorRect | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Placed before paint (useLayoutEffect) so it never flashes at the origin. The
  // observer keeps it placed as the input grows; `at` is the only other input, and
  // a new anchor replaces the card outright.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at`'s primitives are the trigger; the element is read live off the ref
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const GAP = 8;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // No measured gesture (a persisted general draft, say) — park it bottom-right,
      // over the rail it belongs to.
      const left = at
        ? Math.min(vw - w - GAP, Math.max(GAP, at.left - w / 2))
        : Math.max(GAP, vw - w - GAP);
      // Below the selection; above it when that would run off the bottom; pinned to
      // the top when the card is taller than the space either way.
      let top = at ? at.bottom + GAP : vh - h - GAP;
      if (top + h > vh - GAP) top = at ? at.top - GAP - h : vh - h - GAP;
      // Top clamp last, so a composer taller than the viewport pins its TOP —
      // label, quote and input — and lets the buttons overflow below, rather than
      // showing only its tail (the same call the panel's keep-in-view nudge makes).
      top = Math.max(GAP, Math.min(top, vh - h - GAP));
      setPos({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [at?.left, at?.top, at?.bottom]);

  return createPortal(
    <div
      ref={ref}
      // `will-change-transform` buys this box its own compositing layer. Portalled
      // to <body>, it otherwise paints into the ROOT layer — so every keystroke
      // repainted the composer AND the whole page behind it, thousands of
      // highlighted code spans included (~9ms of a 22ms keystroke, measured). On
      // its own layer the repaint is the card. The DOCKED composer needs no
      // equivalent: it paints inside the dock column, well away from the pane's
      // spans, so its invalidation is already its own box.
      className="fixed z-50 w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg bg-white shadow-2xl ring-1 ring-neutral-300 will-change-transform dark:bg-neutral-950 dark:ring-neutral-700"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? undefined : "hidden" }}
    >
      {children}
    </div>,
    document.body,
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
  onFocusFeedback,
  onLocatePin,
  onJumpRef,
  coarse = false,
  keysActive = true,
  collapsed = false,
  onToggleCollapsed,
  composerAt = null,
}: {
  detail: ReviewDetail;
  pending: PendingAnchor | null;
  onDiscardPending: () => void;
  onSubmittedPending: () => void;
  activeFeedbackId: string | null;
  // Bumped on each locate so re-selecting the already-active feedback re-scrolls.
  scrollNonce: number;
  // Locate: focus the feedback AND jump the content pane to its anchor. Only the
  // explicit "take me there" controls fire it — a card's file:line header and the
  // `o` key. null clears the active feedback (focus nothing).
  onLocateFeedback: (fb: FeedbackWithReplies | null) => void;
  // Focus without the jump: the card lights (and scrolls into view in THIS
  // panel), the anchor rings where it already is, the content pane stays put.
  // Everything that merely moves the selection — resolve/reply advancing,
  // `j`/`k`, the optimistic-create select — fires this.
  onFocusFeedback: (fb: FeedbackWithReplies | null) => void;
  onLocatePin: (patchSeq: number, file: string | null, line: number | null) => void;
  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message. The
  // second arg is the message's pinned version — a reply's `ref_version` (round /
  // snapshot captured at post time), or a feedback body's own round.
  onJumpRef: (ref: MessageRef, version: number | null) => void;
  // True when the primary pointer is coarse (ReviewView's usePointerCoarse feeds
  // it — this component can't probe src/mobile/ itself). Composer placeholders
  // drop their keyboard-shortcut hints under it; see CoarsePointerContext.
  coarse?: boolean;
  // False when the panel is mounted but not on screen — below md ReviewView keeps
  // it mounted inside a closed (translated-away, `inert`) bottom sheet, which a
  // desktop window narrowed under 768px enters too. The bindings below fire
  // controls in THIS panel, so leaving them live there would let `S` hand the
  // review to a watching agent, and `e` resolve an item, with nothing on screen
  // to show it happened. An inert prop, not a mobile import (like `coarse`).
  keysActive?: boolean;
  // Desktop: the dock is folded to its rail (settings.ts `r3-feedback-collapsed`).
  // The panel stays MOUNTED — it owns the create mutation, the watcher query and
  // the draft bookkeeping, and a composer opened from the file pane has to land
  // somewhere — so collapsing swaps its chrome for CollapsedRail and floats the
  // composer instead of unmounting anything. Never set below md: there the bottom
  // sheet's closed state already is "collapsed" (see ReviewView).
  collapsed?: boolean;
  // Absent -> the rail's expand button and the header's collapse button don't
  // render, which is what the phone tier and the stories get.
  onToggleCollapsed?: () => void;
  // Where the gesture that opened the composer happened, for the collapsed
  // (floating) composer. Ignored while expanded — the composer docks at the bottom
  // of the list there — and null when nothing measurable raised it.
  composerAt?: AnchorRect | null;
}) {
  const qc = useQueryClient();
  const { copied, failed, copy } = useCopyPrompt(detail.id);
  // Everything the panel derives from the feedback list, in one pass keyed on the
  // list itself. The panel re-renders for plenty of reasons the list has nothing to
  // do with (a resize drag, a tab switch, an SSE echo of an unrelated review) and
  // these feed both the memo'd cards and three effects' deps — so recomputing them
  // per render would hand every consumer a new identity for an unchanged list.
  const { hasUnsent, claims, resolved, active, ordered, feedbackIdsKey, activeIds } =
    useMemo(() => {
      const all = detail.feedback;
      // Resolved feedback lives in its own tab so the working set stays focused. A
      // just-created feedback's stand-in row is already here (the create mutation's
      // onMutate patched the cached ReviewDetail), so it sorts in naturally — feedback
      // is created_at ASC, so it lands last, right above the composer it was typed in.
      const resolved = all.filter((f) => f.status === "resolved");
      const active = all.filter((f) => f.status !== "resolved");
      // Attention-first ordering within the Active tab, with claimed cards ALWAYS at
      // the bottom: once the agent owns the next move, that work gets out of the
      // human's queue regardless of who spoke last. Every partition is stable, so
      // cards retain created_at order within attention/rest/claimed and move only
      // when their turn or claim state changes; auto-animate then FLIPs the reflow.
      const claimed = active.filter((f) => f.claim != null);
      const unclaimed = active.filter((f) => f.claim == null);
      const ordered = [
        ...unclaimed.filter(needsAttention),
        ...unclaimed.filter((f) => !needsAttention(f)),
        ...claimed,
      ];
      return {
        // The SHARED unsent predicate (shared/types.ts hasUnsentContent — the same one
        // the server renders prompts by and `r3 watch` wakes on); gates Copy/Submit —
        // nothing to send once everything's delivered (a fresh reply/feedback/decision
        // re-enables it live).
        hasUnsent: all.some(hasUnsentContent),
        claims: all.flatMap((fb) => (fb.claim ? [fb.claim] : [])),
        resolved,
        active,
        ordered,
        // The membership keys two effects below read (draft reaping, the active-card
        // scroll); joined ids so they fire on a membership change, not a row edit.
        feedbackIdsKey: all.map((f) => f.id).join(","),
        activeIds: ordered.map((f) => f.id).join(","),
      };
    }, [detail.feedback]);
  const working = claims.length > 0;
  // The general note's text lives in the browser draft store (persisted, lights the
  // pill); `generalOpen` is just the local "is the composer showing" bit. It's kept
  // showing while there's text too (below), so it survives being hidden behind an
  // anchored draft and restores on reload. Only the empty/non-empty FLIP is read
  // here — GeneralFeedback owns the text subscription (as NewFeedback does), so
  // typing in it re-renders that composer, not the panel and every card under it.
  const [generalOpen, setGeneralOpen] = useState(false);
  const hasGeneralText = useHasGeneralText(detail.id);
  const showGeneral = generalOpen || hasGeneralText;
  // A failed create's message: the create mutation lives on the panel (below), so
  // its error can't ride the composer's own hook — surface it back on the restored
  // composer. Cleared when a fresh compose starts (onMutate) or a composer closes.
  const [createError, setCreateError] = useState<string | null>(null);
  // Card-mutation errors (reply/resolve/reopen/edit/delete) keyed by feedback id.
  // Hoisted here — not into the card — so a message survives the unmount/remount a
  // status- or membership-changing action triggers: resolve/reopen/delete move the
  // card across the Active/Resolved tab filter (or out of the list entirely), and
  // the failed one's rollback remounts a fresh card whose local mutation state is
  // reset. Each card's onError writes here; beginPatch clears it as the next action
  // starts. Stale entries (feedback later deleted) are never read, so they're inert.
  const [cardErrors, setCardErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  // The last `r`/`e` keystroke, addressed to the card that was active when it was
  // pressed; renderCard hands it to that card and null to every other. See
  // CardCommand for why it carries both an id and a nonce.
  const [cardCommand, setCardCommand] = useState<CardCommand | null>(null);
  const setCardError = useCallback((id: string, msg: string | null) => {
    setCardErrors((m) => {
      if ((m.get(id) ?? null) === msg) return m;
      const next = new Map(m);
      if (msg == null) next.delete(id);
      else next.set(id, msg);
      return next;
    });
  }, []);
  // The optimistic create inserts a stand-in card under a throwaway id, then swaps
  // in the server row (real id) once the POST returns. Keying the card on the
  // server id would make that swap a list remove+add — the placeholder would slide
  // out while the real card rises in. Instead pin the real row back under the
  // placeholder's key so the card keeps its DOM node across the swap (auto-animate
  // sees no structural change). realId → stable key; every other row keys on its
  // own id (keyFor falls through).
  const clientKey = useRef(new Map<string, string>());
  const keyFor = (id: string) => clientKey.current.get(id) ?? id;
  // The latest active feedback id, read inside the async create mutation without
  // re-subscribing it — so onSuccess can tell whether the human is still focused on
  // the just-created card (re-select it under its real id) or has moved on.
  const activeIdRef = useRef(activeFeedbackId);
  activeIdRef.current = activeFeedbackId;

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
      const elR = el.getBoundingClientRect();
      const paneR = pane.getBoundingClientRect();
      const overflowBelow = elR.bottom - paneR.bottom + 12;
      // Cap the nudge so the composer's TOP never scrolls out of view: when it's
      // taller than the pane (the mobile peek sheet), pin the top — label + quote
      // + input start — and let the buttons overflow below, instead of showing
      // just the tail.
      if (overflowBelow > 0)
        pane.scrollTop += Math.min(overflowBelow, Math.max(0, elR.top - paneR.top));
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
  // Why the hand-off (Copy/Submit) is disabled, or null when it's live. Both the
  // watching-Submit and the Copy button share this reason; only their *enabled*
  // title differs (Submit names the action, Copy has none).
  const disabledReason = unsavedDraft
    ? "Add, post, or discard your unsaved draft(s) first"
    : !hasUnsent
      ? "Everything has been sent — a new reply or feedback re-enables this"
      : null;

  // Reap reply drafts whose feedback is gone (deleted here or by another client) so
  // an orphan can't keep the pill lit / hand-off blocked with no card to clear it.
  // Keyed on the id set (feedbackIdsKey) so it only runs when membership changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail.feedback is captured via feedbackIdsKey; re-run only when the id set changes
  useEffect(() => {
    pruneReplyDrafts(
      detail.id,
      detail.feedback.map((f) => f.id),
    );
  }, [detail.id, feedbackIdsKey]);

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

  // The displayed order, for the two advance handlers below. Held in a ref so they
  // can stay identity-stable (a fresh arrow per render would defeat FeedbackCard's
  // memo); written during render, so a handler fired from a mutation's onMutate
  // still reads THIS render's pre-mutation list — exactly what the inline closures
  // it replaces used to capture.
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;

  // Resolving a card advances focus to the next still-open item so a top-down
  // pass keeps moving, instead of trailing the resolved item over to the
  // Resolved tab. Take the item that slides into the resolved one's slot; if it
  // was last, fall back to the new last; if nothing's left, focus nothing.
  // Computed off this render's pre-resolve `ordered` list (the displayed,
  // attention-first order — which still includes the item being resolved).
  // Focus, not locate (both advances): the human is working the *list*, so the
  // content pane must not chase each next card's anchor across the review —
  // jumping stays an explicit gesture (the file:line header, `o`).
  const advanceAfterResolve = useCallback(
    (resolvedId: string) => {
      const ordered = orderedRef.current;
      const idx = ordered.findIndex((f) => f.id === resolvedId);
      const remaining = ordered.filter((f) => f.id !== resolvedId);
      onFocusFeedback(remaining.length === 0 ? null : (remaining[idx] ?? remaining.at(-1)!));
    },
    [onFocusFeedback],
  );

  // Replying (without resolving) to an attention-group card sinks it out of the
  // group, so — like resolving — advance focus to the next item down instead of
  // trailing the just-answered card to the bottom. A rest-group card doesn't move
  // on a plain reply (the human already had the last word), so advancing off it
  // would yank the view from a stationary card — leave focus where it is. Unlike
  // resolve, the card stays in the list, so there's no "slides into its slot"
  // fallback: strictly-next or stay (don't jump backward to a card already
  // handled). Computed off this render's pre-reply order.
  const advanceAfterReply = useCallback(
    (repliedId: string) => {
      const ordered = orderedRef.current;
      const idx = ordered.findIndex((f) => f.id === repliedId);
      if (idx < 0 || !needsAttention(ordered[idx])) return;
      const next = ordered[idx + 1];
      if (next) onFocusFeedback(next);
    },
    [onFocusFeedback],
  );

  // One card renderer for both tabs. The Active tab maps it over `ordered` (the
  // attention-first unclaimed cards followed by claimed cards); the Resolved tab
  // reuses it unchanged — its advance
  // callbacks are inert there: a resolved card shows Reopen (never Resolve), so
  // onResolved never fires, and advanceAfterReply early-returns for an id that
  // isn't in `ordered` (which holds only active items).
  //
  // Every prop here is passed BY IDENTITY, never as a fresh arrow: each handler
  // takes the card's own row/id, so one function serves the whole list and
  // FeedbackCard's memo actually holds. Building five closures per card here is
  // what used to re-render every card (and re-run its mutation hooks) on any panel
  // render at all.
  const renderCard = (fb: FeedbackWithReplies) => (
    <FeedbackCard
      key={keyFor(fb.id)}
      fb={fb}
      reviewId={detail.id}
      isActive={fb.id === activeFeedbackId}
      onLocate={onLocateFeedback}
      onFocus={onFocusFeedback}
      onLocatePin={onLocatePin}
      onResolved={advanceAfterResolve}
      onReplied={advanceAfterReply}
      onJumpRef={onJumpRef}
      command={cardCommand?.id === fb.id ? cardCommand : null}
      error={cardErrors.get(fb.id) ?? null}
      reportError={setCardError}
    />
  );

  // Create feedback optimistically — the same shape as the card mutations
  // (resolve/reply/edit/delete): onMutate patches the cached ReviewDetail so the
  // new card appears the instant the composer is submitted, onError rolls the
  // snapshot back (and restores the composer draft so a failed add isn't lost), and
  // the write's own SSE echo refetch reconciles the server-derived fields (real id,
  // code_sha, exact anchor state, sent_at). No onSettled refetch — the echo is the
  // single reconcile path, as with the other mutations.
  //
  // The mutation lives here on the panel rather than in the composer components:
  // onMutate clears the composer (which unmounts NewFeedback/GeneralFeedback), and a
  // child's mutation callbacks can't be relied on to run after it unmounts. The
  // note body + anchor + composer clear/restore all ride as mutate *variables* so a
  // pending mutation's re-synced options never read post-clear draft state.
  const reviewKey = ["review", detail.id] as const;
  const { beginPatch, restore } = useOptimisticPatch(detail.id);
  // A stand-in feedback row shown while the POST is in flight. Its id is a throwaway
  // the reconcile re-keys under (clientKey); the server-derived fields aren't known
  // yet, so code_sha/sent_at stay null and the anchor is an optimistic "anchored"
  // (the echo corrects it — a files-review note against a snapshot may relocate).
  const optimisticFeedback = (anchor: PendingAnchor | null, body: string): FeedbackWithReplies => ({
    // Math.random (not crypto.randomUUID, which is secure-context-only) — a
    // throwaway local id, same as the optimistic-reply stand-in.
    id: `feedback_tmp_${Math.random().toString(36).slice(2, 10)}`,
    review_id: detail.id,
    author: "human",
    body,
    file: anchor?.file ?? "", // "" = general (review-level) feedback
    side: anchor?.side ?? null,
    line_start: anchor?.lineStart ?? null,
    line_end: anchor?.lineEnd ?? null,
    quote: anchor?.quote ?? null,
    code_sha: null,
    anchor: "anchored",
    status: "open",
    patch_seq: anchor?.patchSeq ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sent_at: null,
    status_unsent: false,
    replies: [],
    claim: null,
  });
  const addFeedback = useMutation({
    onMutate: async (v: {
      anchor: PendingAnchor | null;
      body: string;
      clear: () => void;
      restore: () => void;
    }) => {
      setCreateError(null);
      const prev = await beginPatch();
      const row = optimisticFeedback(v.anchor, v.body);
      qc.setQueryData<ReviewDetail>(reviewKey, (d) =>
        d ? { ...d, feedback: [...d.feedback, row] } : d,
      );
      // Clear the composer + reveal the new card the instant it's submitted, and
      // focus it: select it (amber rail) and scroll its card up. Focus, not
      // locate — an anchored note's lines are the selection still under the
      // human's eyes, so there is nothing to jump the file pane to.
      v.clear();
      setTab("active");
      onFocusFeedback(row);
      return { prev, tmpId: row.id };
    },
    mutationFn: (v: {
      anchor: PendingAnchor | null;
      body: string;
      clear: () => void;
      restore: () => void;
    }) =>
      api.addFeedback(
        detail.id,
        v.anchor
          ? {
              file: v.anchor.file,
              side: v.anchor.side,
              lineStart: v.anchor.lineStart,
              lineEnd: v.anchor.lineEnd,
              quote: v.anchor.quote,
              body: v.body,
              author: "human",
              patchSeq: v.anchor.patchSeq ?? null,
            }
          : { lineStart: null, lineEnd: null, body: v.body, author: "human" },
      ),
    onSuccess: (fb, _v, ctx) => {
      if (!ctx?.tmpId) return;
      // Pin the server row back under the placeholder's key so the card keeps its
      // DOM node across the id swap (no exit/enter animation), then swap the
      // stand-in for the authoritative row (real id) so an immediate
      // resolve/reply/edit hits a real id even if the SSE echo never lands.
      clientKey.current.set(fb.id, ctx.tmpId);
      qc.setQueryData<ReviewDetail>(reviewKey, (d) =>
        d
          ? {
              ...d,
              feedback: d.feedback.map((f) =>
                f.id === ctx.tmpId ? { ...fb, replies: [], claim: null } : f,
              ),
            }
          : d,
      );
      // Re-select the card under its real id so it stays lit across the swap — but
      // only if the human is still focused on it (they may have clicked away).
      // Focus: a background id swap must never move the content pane.
      if (activeIdRef.current === ctx.tmpId) onFocusFeedback({ ...fb, replies: [], claim: null });
    },
    onError: (e, v, ctx) => {
      restore(ctx?.prev);
      // Put the composer back with its text so the note isn't lost, and show why.
      v.restore();
      setCreateError(apiErrorText(e));
    },
  });

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
  // (`activeIds` is the memo'd membership key computed at the top of the panel.)
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

  const { copied: sent, flash: flashSent } = useCopyFlash(1800);
  // Submit answers 502 when the agent registered via `r3 listen` can no longer be
  // reached: the daemon drops the registration, so the button falls back to "Copy
  // prompt" on its own — but a hand-off that reached nobody must not look like one
  // that landed, which is the whole reason the server waits for that write.
  const [handOffError, setHandOffError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () => api.submit(detail.id),
    onError: (err) =>
      setHandOffError(
        err instanceof ApiError && err.status === 502
          ? "The agent waiting on this review is gone — nothing was delivered. Copy the prompt instead."
          : "Submit failed — nothing was delivered.",
      ),
    onSuccess: () => {
      setHandOffError(null);
      // Optimistically drain the watcher list so the button flips to "Copy
      // prompt" the instant we submit. `r3 watch` exits on the `submitted`
      // broadcast, but its refetch lags ~1s. The next watchers-changed
      // invalidation (or the 30s interval) overwrites this with server truth,
      // so a fresh `r3 watch` re-shows the Submit button on its own.
      qc.setQueryData<WatchersResponse>(["watchers", detail.id], { watchers: [] });
      flashSent();
    },
  });

  // --- Keyboard bindings (keys.ts) ---------------------------------------
  // The panel owns the Review + Feedback groups because it owns the state they
  // read: the composer, the hand-off, and which card is active. Every handler is
  // the onClick of a control rendered below, under the same guard — a keystroke
  // must never do something its button wouldn't.
  //
  // `j`/`k` walk the list AS DISPLAYED (the active tab's order — attention-first
  // in Active), so the selection moves the way the eye does. With nothing active
  // they enter from the end you're heading toward: `j` takes the first card, `k`
  // the last. Focus only: the ring moves card to card but the content pane stays
  // put — `o` is the explicit "take me to its anchor".
  const navList = tab === "active" ? ordered : resolved;
  const step = (delta: 1 | -1) => {
    if (navList.length === 0) return;
    const at = navList.findIndex((f) => f.id === activeFeedbackId);
    if (at < 0) {
      onFocusFeedback(delta === 1 ? navList[0] : navList[navList.length - 1]);
      return;
    }
    // Clamped, not wrapping: running off the end shouldn't silently teleport you
    // back to the top of a list you just finished walking.
    const next = navList[Math.min(navList.length - 1, Math.max(0, at + delta))];
    if (next) onFocusFeedback(next);
  };
  const command = (action: CardCommand["action"]) => {
    const id = activeFeedbackId;
    if (!id) return;
    setCardCommand((c) => ({ id, action, nonce: (c?.nonce ?? 0) + 1 }));
  };
  // An empty map with the panel off screen: every id falls through to unbound,
  // which is also what greys its row in the `?` sheet. Off screen means either
  // tier's way of putting it there — the phone's closed sheet (`keysActive`) or
  // the desktop rail (`collapsed`). Every handler below fires a control in the
  // panel's own chrome, and none of that chrome is on the rail.
  useKeyBindings(
    keysActive && !collapsed
      ? {
          generalNote: () => {
            setCreateError(null);
            onDiscardPending(); // one composer at a time — same as the header's + button
            setTab("active");
            setGeneralOpen(true);
          },
          // The one binding that sends data out of the app; `disabledReason` is
          // exactly what greys the button out, so a shifted `S` on a disabled
          // hand-off is inert.
          handOff: () => {
            if (disabledReason) return;
            if (watching) {
              if (!submit.isPending) submit.mutate();
            } else {
              copy();
            }
          },
          fbNext: () => step(1),
          fbPrev: () => step(-1),
          // Re-locating the already-active feedback re-scrolls the pane to its
          // anchor (onLocateFeedback bumps scrollNonce), which is the whole point
          // of `o`: you've scrolled away reading and want to get back to what the
          // note is about.
          fbLocate: () => {
            const fb = detail.feedback.find((f) => f.id === activeFeedbackId);
            if (fb) onLocateFeedback(fb);
          },
          fbReply: () => command("reply"),
          fbResolve: () => command("resolve"),
        }
      : {},
  );

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
      onDiscard={() => {
        setCreateError(null);
        onDiscardPending();
      }}
      onSubmit={(body) =>
        addFeedback.mutate({
          anchor: pending,
          body,
          clear: onSubmittedPending,
          // Rebuild the anchored draft (anchor + text) so a failed add reopens the
          // composer exactly as it was submitted.
          restore: () => {
            setDraftAnchor(detail.id, pending);
            setDraftText(detail.id, body);
          },
        })
      }
      submitPending={addFeedback.isPending}
      submitError={createError}
    />
  ) : showGeneral ? (
    <GeneralFeedback
      reviewId={detail.id}
      onClose={() => {
        setCreateError(null);
        closeGeneral();
      }}
      onSubmit={(body) =>
        addFeedback.mutate({
          anchor: null,
          body,
          clear: closeGeneral,
          restore: () => setGeneralText(detail.id, body),
        })
      }
      submitPending={addFeedback.isPending}
      submitError={createError}
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

  // Folded to the rail: the signals stay on screen and the composer comes to the
  // gesture instead of docking at the bottom of a list nobody can see. One
  // `composerContent`, two mounts — the same shape as the desktop/mobile fork of
  // the panel itself, so the two surfaces can't drift apart.
  if (collapsed)
    return (
      <CoarsePointerContext.Provider value={coarse}>
        <CollapsedRail
          openCount={active.length}
          unsaved={unsavedDraft}
          unsent={hasUnsent}
          live={watching || working}
          onExpand={() => onToggleCollapsed?.()}
        />
        {composerOpen && <FloatingComposer at={composerAt}>{composerContent}</FloatingComposer>}
      </CoarsePointerContext.Provider>
    );

  return (
    <CoarsePointerContext.Provider value={coarse}>
      <div className="flex h-full flex-col">
        {/* The title/CTA row and the filter-pills row share one padded flex box:
          gap-2 between the rows and padding on the parent (not per-row py) keep
          their spacing consistent, and the border sits under the whole header.
          The header's heights are its own — deliberately NOT matched to the file
          pane's bars across the split (equal heights there read as one bar). */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-base font-semibold">Feedback</span>
              {/* The FileBrowser header's fold control, mirrored: same glyph, same
                  bare styling, pointing the way this dock folds. It rides the
                  TITLE rather than the action cluster on the right — the cluster is
                  things you do to the review (add a note, hand it off), and folding
                  the panel is a thing you do to the panel. Desktop only: ReviewView
                  withholds the callback below md, where the bottom sheet's own
                  handle is the equivalent control. */}
              {onToggleCollapsed && (
                <button
                  type="button"
                  aria-label="Hide feedback"
                  title="Hide feedback"
                  onClick={onToggleCollapsed}
                  className="flex shrink-0 cursor-pointer text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <FoldChevrons dir="right" />
                </button>
              )}
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
              {/* One composer at a time: opening general discards a pending
                  anchored draft. */}
              <button
                type="button"
                aria-label="Add general feedback"
                title="Add general feedback — a note about the review as a whole, not tied to any line"
                onClick={() => {
                  setCreateError(null);
                  onDiscardPending();
                  setTab("active");
                  setGeneralOpen(true);
                }}
                // max-md:size-9 gives the icon a compact touch target below md (the
                // icon itself stays size-4); it sits beside the min-h-9 Submit/Copy
                // button, so the header row reads as one comfortable-tap cluster.
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 max-md:size-9 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
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
                  title={disabledReason ?? "Send the feedback to the watching agent"}
                >
                  <Button
                    variant="primary"
                    onClick={() => submit.mutate()}
                    disabled={!hasUnsent || submit.isPending || unsavedDraft}
                  >
                    Submit
                  </Button>
                </span>
              ) : working && !hasUnsent ? (
                <span className="inline-flex shrink-0" title={claimsTitle(claims)}>
                  <Button variant="primary" disabled>
                    Working…
                  </Button>
                </span>
              ) : (
                <span className="inline-flex shrink-0" title={disabledReason ?? undefined}>
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
          {(detail.feedback.length > 0 || watching || working) && (
            // Fixed height (the pills' 1.25rem) so this secondary row never changes
            // the header's height. Everything here is ≤ 1.25rem, so the min-height
            // simply pins the row and its contents just center within it. (The
            // unsaved-draft chip now lives up in the title row, not here.)
            <div className="flex min-h-5 items-center justify-between gap-2">
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
                      className={cn(
                        "pointer-events-none absolute left-0 rounded transition-[transform,width] duration-150 ease-out will-change-transform motion-reduce:transition-none",
                        // The highlight carries the tab's meaning, not just its
                        // position: green while Resolved is showing. Sitting in
                        // the Resolved tab and reading it as the working set is
                        // the mistake this whole colour thread exists to prevent.
                        tab === "resolved"
                          ? "bg-success-200 dark:bg-success-900"
                          : "bg-neutral-200 dark:bg-neutral-700",
                      )}
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
                        tab !== id
                          ? "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                          : id === "resolved"
                            ? "text-success-900 dark:text-success-100"
                            : "text-neutral-900 dark:text-neutral-100",
                      )}
                    >
                      {label} <span className="font-normal text-neutral-400">· {count}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <span />
              )}
              {(watching || working) && (
                <div className="flex min-w-0 items-center gap-3 text-[0.6875rem]">
                  {working && (
                    <span
                      className="flex min-w-0 items-center gap-1.5 text-primary-700 dark:text-primary-400"
                      title={claimsTitle(claims)}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-primary-500" />
                      <PresenceText label={claimsLabel(claims)} />
                    </span>
                  )}
                  {watching && (
                    <span
                      className="flex min-w-0 items-center gap-1.5 text-primary-700 dark:text-primary-400"
                      title={watchersTitle(watchers)}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-primary-500" />
                      <PresenceText label={watchersLabel(watchers)} />
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {handOffError && (
            <div className="text-[0.6875rem] text-danger-600 dark:text-danger-400">
              {handOffError}
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
                <div ref={listAnim}>{ordered.map(renderCard)}</div>
              </>
            ) : resolved.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-neutral-400">
                No resolved feedback yet.
              </p>
            ) : (
              <div ref={listAnim}>{resolved.map(renderCard)}</div>
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
              className={cn(
                composerOpen && "border-y-2 border-neutral-300 dark:border-neutral-700",
              )}
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
    </CoarsePointerContext.Provider>
  );
});
