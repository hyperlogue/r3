import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  artifactFeedbackTargetLabel,
  artifactTargetLabel,
} from "../../../shared/artifact-prompt.ts";
import {
  type ArtifactDetail,
  type ArtifactFeedback,
  type ArtifactKind,
  type ArtifactMessageContext,
  type ArtifactTarget,
  hasUnsentArtifactFeedback,
} from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts, useArtifactNoteOpen } from "../artifact-drafts.ts";
import { activeArtifactFeedback, artifactNeedsAttention } from "../artifact-feedback.ts";
import { useFeedbackStatus, useOptimisticArtifact } from "../artifact-feedback-status.ts";
import {
  FeedbackCreationContext,
  feedbackAnimation,
  useFeedbackTabIndicator,
} from "../feedback-motion.ts";
import { useKeyBindings } from "../keys.ts";
import type { MessageRef } from "../markdown.ts";
import {
  Button,
  CommentPlusIcon,
  cn,
  FoldTriangle,
  MoreActionsButton,
  useEscape,
  usePopoverFocus,
} from "../ui.tsx";
import { useArtifactHandoff } from "../useArtifactHandoff.ts";
import { ArtifactComposer } from "./ArtifactComposer.tsx";
import { MessageProse, QuoteBubble, useQuoteBubble } from "./Message.tsx";
import { MessageInput } from "./MessageInput.tsx";

export type ArtifactRefJump = (reference: MessageRef, context: ArtifactMessageContext) => void;
export type ArtifactTargetJump = (target: ArtifactTarget, feedbackId?: string) => void;

function targetContext(target: ArtifactTarget): ArtifactMessageContext {
  return "versionSeq" in target
    ? {
        versionSeq: target.versionSeq,
        representation: target.kind === "version_summary" ? null : target.kind,
      }
    : { versionSeq: null, representation: null };
}

// Compact browser labels without changing the explicit context kept in prompts,
// targets, or Locate actions. Latest means published, not the selected version.
function cardTargetLabel(target: ArtifactTarget, latestVersionSeq: number | null): string {
  const label = artifactTargetLabel(target);
  if (!("path" in target)) return label;
  return label.replace(
    `Version ${target.versionSeq} · ${target.kind} · `,
    target.versionSeq === latestVersionSeq ? "" : `Version ${target.versionSeq} · `,
  );
}

function fixTargetLabel(
  target: ArtifactTarget,
  latestVersionSeq: number | null,
  artifactKind: ArtifactKind,
): string {
  if (artifactKind !== "html" || target.kind !== "rendered")
    return cardTargetLabel(target, latestVersionSeq);
  const label = target.locator?.label ?? (target.locator ? "Page element" : "Page");
  return target.versionSeq === latestVersionSeq ? label : `Version ${target.versionSeq} · ${label}`;
}

function FeedbackQuote({ quote }: { quote: string }) {
  const element = useRef<HTMLQuoteElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  useLayoutEffect(() => {
    const node = element.current!;
    const measure = () => {
      if (!node.clientWidth) return;
      // line-clamp retains the full scroll height. Compare with its three-line
      // limit even while expanded, so resizing cannot hide a needed toggle.
      const limit = parseFloat(getComputedStyle(node).lineHeight) * 3;
      setHasMore(node.scrollHeight > limit + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the explicit toggle is keyboard accessible; clicking the quote is a selection-preserving pointer convenience. */}
      <blockquote
        id={id}
        ref={element}
        className={cn(
          "mb-2 overflow-hidden border-l-2 border-neutral-300 pl-2 text-xs text-neutral-500 whitespace-pre-wrap",
          !open && "line-clamp-3",
          hasMore && "cursor-pointer",
        )}
        onClick={() => {
          if (hasMore && window.getSelection()?.isCollapsed) setOpen((value) => !value);
        }}
        title={hasMore ? `Click to ${open ? "collapse" : "expand"} · drag to select` : undefined}
      >
        {quote}
      </blockquote>
      {hasMore && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          className="mb-2 text-[0.625rem] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Collapse quote" : "Expand quote"}
        </button>
      )}
    </>
  );
}

export const ArtifactThreadCard = memo(function ArtifactThreadCard({
  feedback,
  context,
  artifactKind,
  latestVersionSeq,
  onLocate,
  onJumpRef,
  active = false,
  visible = true,
  onResolved,
}: {
  feedback: ArtifactFeedback;
  context: ArtifactMessageContext;
  artifactKind: ArtifactKind;
  latestVersionSeq: number | null;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  active?: boolean;
  visible?: boolean;
  onResolved?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) element.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<{ replyId?: string; body: string } | null>(null);
  const isEditing = editing !== null;
  useEffect(() => {
    if (isEditing)
      element.current?.querySelector<HTMLTextAreaElement>("[data-edit-message] textarea")?.focus();
  }, [isEditing]);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  usePopoverFocus(menuOpen, menu, menuTrigger);
  const [earlierOpen, setEarlierOpen] = useState(false);
  useEscape(menuOpen, () => setMenuOpen(false));
  const lastReply = feedback.replies.at(-1);
  const canEdit = (lastReply?.author ?? feedback.author).role === "human";
  const openReply = () => {
    artifactDrafts.beginReply(feedback.artifactId, feedback.id, context);
    setReplying(true);
    requestAnimationFrame(() => {
      const input = element.current?.querySelector<HTMLTextAreaElement>("[data-reply-to] textarea");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollTop = input.scrollHeight;
    });
  };
  const bubble = useQuoteBubble(element, (range) => {
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return visible && !!element?.closest('[data-message-author="agent"]');
  });
  useEffect(() => {
    if (!visible) {
      setMenuOpen(false);
      bubble.hide();
    }
  }, [visible, bubble.hide]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["artifact", feedback.artifactId] });
  const edit = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      if (editing.replyId) await artifactApi.editReply(editing.replyId, editing.body);
      else await artifactApi.editFeedback(feedback.id, { body: editing.body });
    },
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
  });
  const status = useFeedbackStatus(feedback);
  const remove = useMutation({
    mutationFn: () => artifactApi.deleteFeedback(feedback.id),
    onSuccess: refresh,
  });
  const unavailable = artifactFeedbackTargetLabel(feedback) === "Historical target unavailable";
  const hasTarget = unavailable || feedback.target.kind !== "artifact";
  const originalContext = targetContext(feedback.target);
  const quote =
    "locator" in feedback.target && feedback.target.locator && "quote" in feedback.target.locator
      ? feedback.target.locator.quote
      : null;
  const error = edit.error ?? status.error ?? remove.error;
  const resolveButton = (
    <Button
      type="button"
      data-feedback-action="resolve"
      variant={feedback.status === "open" ? "success-outline" : "ghost"}
      disabled={status.isPending}
      className={feedback.status === "resolved" ? "text-neutral-400" : undefined}
      onClick={() => {
        status.change(feedback.status === "open" ? "resolved" : "open");
        if (feedback.status === "open") onResolved?.(feedback.id);
      }}
    >
      {feedback.status === "open" ? "✓ Resolve" : "Reopen"}
    </Button>
  );
  const moreMenu = (
    <div className="relative">
      <MoreActionsButton
        ref={menuTrigger}
        title="More actions"
        aria-label="More actions"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((value) => !value)}
      />
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            ref={menu}
            role="dialog"
            aria-label="Feedback actions"
            className="absolute top-full left-0 z-50 mt-1 w-28 overflow-hidden rounded-md border border-neutral-300 bg-white r3-popover dark:border-neutral-700 dark:bg-neutral-950"
          >
            <button
              type="button"
              disabled={!canEdit}
              title={canEdit ? undefined : "The agent replied last — post a new reply instead"}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100 disabled:text-neutral-400 dark:hover:bg-neutral-800"
              onClick={() => {
                setEditing(
                  lastReply
                    ? { replyId: lastReply.id, body: lastReply.body }
                    : { body: feedback.body },
                );
                setMenuOpen(false);
                setReplying(false);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-xs text-danger-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => {
                setDeleting(true);
                setMenuOpen(false);
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
  const editForm = editing && (
    <form
      data-edit-message
      className="-mx-3 flex flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (editing.body.trim() && !edit.isPending) edit.mutate();
      }}
    >
      <MessageInput
        aria-label="Edit message"
        value={editing.body}
        onChange={(event) => setEditing({ ...editing, body: event.target.value })}
        disabled={edit.isPending}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form?.requestSubmit();
          } else if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
          }
        }}
      />
      <div className="flex justify-end gap-2 px-3">
        <Button type="button" disabled={edit.isPending} onClick={() => setEditing(null)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!editing.body.trim() || edit.isPending}>
          {edit.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
  return (
    <article
      ref={element}
      data-artifact-feedback={feedback.id}
      className={cn(
        "relative border-b border-neutral-200 px-3 py-3 text-sm dark:border-neutral-800",
        feedback.status === "resolved"
          ? "bg-success-50/60 dark:bg-success-950/20"
          : "bg-white dark:bg-neutral-950",
        feedback.claim && "bg-neutral-100/70 dark:bg-neutral-900/70",
        active &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-warning-500",
      )}
    >
      {feedback.claim && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-neutral-500/10"
        />
      )}
      {(hasTarget || artifactNeedsAttention(feedback) || feedback.status === "resolved") && (
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2 text-xs">
          {artifactNeedsAttention(feedback) && (
            <span
              title="Unhandled agent response"
              className="mt-1 size-1.5 shrink-0 rounded-full bg-primary-500"
            />
          )}
          {unavailable ? (
            <span className="text-amber-700 dark:text-amber-400">
              Historical target unavailable
            </span>
          ) : hasTarget ? (
            <button
              type="button"
              className="min-w-0 flex-1 break-all text-left text-primary-700 underline-offset-2 hover:underline dark:text-primary-300"
              title={artifactFeedbackTargetLabel(feedback)}
              onClick={() => onLocate(feedback.target, feedback.id)}
            >
              {cardTargetLabel(feedback.target, latestVersionSeq)}
            </button>
          ) : null}
          {feedback.status === "resolved" && (
            <span className="rounded bg-success-500/15 px-1.5 py-0.5 font-semibold text-success-700 dark:text-success-300">
              ✓ resolved
            </span>
          )}
        </div>
      )}
      {(hasUnsentArtifactFeedback(feedback) || feedback.claim) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {hasUnsentArtifactFeedback(feedback) && <span>Not sent</span>}
          {feedback.claim && (
            <span
              className="relative z-20 rounded bg-primary-500/15 px-1.5 py-0.5 text-primary-700 dark:text-primary-300"
              title={`Working agent: ${feedback.claim.sessionId}`}
            >
              Working · {feedback.claim.sessionId.slice(0, 16)}
            </span>
          )}
        </div>
      )}
      {quote && <FeedbackQuote quote={quote} />}
      {unavailable && (
        <details className="mb-2 text-xs text-neutral-500">
          <summary>Imported anchor evidence</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(feedback.legacy?.source, null, 2)}
          </pre>
        </details>
      )}
      <div
        data-message-author={feedback.author.role}
        className={cn(
          feedback.author.role === "agent" &&
            "rounded-md bg-primary-100/60 px-2.5 py-1.5 dark:bg-primary-500/15",
        )}
      >
        {feedback.author.role === "agent" && (
          <div className="mb-1 text-xs text-neutral-500" title={feedback.author.sessionId}>
            Agent · {feedback.author.sessionId.slice(0, 20)}
          </div>
        )}
        {editing && !editing.replyId ? (
          editForm
        ) : (
          <MessageProse
            source={feedback.body}
            onJumpRef={(ref) => onJumpRef(ref, originalContext)}
          />
        )}
      </div>
      {feedback.replies.length > 3 && (
        <button
          type="button"
          className="mt-2.5 flex items-center gap-1 text-[0.6875rem] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          onClick={() => setEarlierOpen((value) => !value)}
        >
          <FoldTriangle open={earlierOpen} className="size-2.5" />
          {earlierOpen ? "hide earlier replies" : `${feedback.replies.length - 3} earlier replies`}
        </button>
      )}
      {(earlierOpen ? feedback.replies : feedback.replies.slice(-3)).map((reply) => (
        <div
          key={reply.id}
          data-message-author={reply.author.role}
          className={cn(
            "mt-2.5",
            reply.author.role === "agent" &&
              "rounded-md bg-primary-100/60 px-2.5 py-1.5 dark:bg-primary-500/15",
          )}
        >
          {reply.author.role === "agent" && (
            <div className="mb-1 text-xs text-neutral-500" title={reply.author.sessionId}>
              Agent · {reply.author.sessionId.slice(0, 20)}
            </div>
          )}
          {editing?.replyId === reply.id ? (
            editForm
          ) : (
            <MessageProse source={reply.body} onJumpRef={(ref) => onJumpRef(ref, reply.context)} />
          )}
          {reply.target && (
            <button
              type="button"
              className="mt-2 text-left text-xs text-primary-700 hover:underline dark:text-primary-300"
              title={
                artifactKind === "html" && reply.target.kind === "rendered"
                  ? `Version ${reply.target.versionSeq} · ${reply.target.locator?.selector ?? "Page"}`
                  : artifactTargetLabel(reply.target)
              }
              onClick={() => onLocate(reply.target!, feedback.id)}
            >
              ↳ Fix: {fixTargetLabel(reply.target, latestVersionSeq, artifactKind)}
            </button>
          )}
          {reply.legacy && (
            <details className="mt-1 text-xs text-neutral-500">
              <summary>Imported reference evidence</summary>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(reply.legacy, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error.message}
        </p>
      )}
      {!editing && !replying && (
        <div className="mt-3 flex items-center gap-1 text-[0.6875rem]">
          {resolveButton}
          {moreMenu}
          <Button className="ml-auto" data-feedback-action="reply" onClick={openReply}>
            Reply
          </Button>
        </div>
      )}
      {deleting && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>Delete this thread and its replies?</span>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete thread
          </Button>
          <Button onClick={() => setDeleting(false)}>Keep</Button>
        </div>
      )}
      {replying && (
        <div className="-mx-3 mt-3">
          <ArtifactComposer
            artifactId={feedback.artifactId}
            replyTo={feedback.id}
            leadingActions={
              <>
                {resolveButton}
                {moreMenu}
              </>
            }
            onDone={() => setReplying(false)}
          />
        </div>
      )}
      {visible && bubble.pos && (
        <QuoteBubble
          pos={bubble.pos}
          label="Quote in reply"
          onQuote={(text) => {
            openReply();
            const draft = artifactDrafts.get(feedback.artifactId, feedback.id);
            const body = draft?.body ?? "";
            artifactDrafts.update(
              feedback.artifactId,
              {
                body: `${body.trim() ? `${body}\n\n` : ""}${text
                  .split("\n")
                  .map((line) => `> ${line}`)
                  .join("\n")}\n\n`,
              },
              feedback.id,
            );
            bubble.hide();
          }}
        />
      )}
    </article>
  );
});

export type ArtifactFeedbackTab = "active" | "resolved";

// Each queue owns its scroll position and row animation. Switching tabs changes
// only the track transform, so cards, reply editors, and the Active draft survive.
function FeedbackQueue({
  tab,
  selected,
  tabsId,
  empty,
  children,
}: {
  tab: ArtifactFeedbackTab;
  selected: boolean;
  tabsId: string;
  empty: boolean;
  children: ReactNode;
}) {
  const [listAnimation] = useAutoAnimate<HTMLDivElement>(feedbackAnimation);
  return (
    <div
      role="tabpanel"
      id={`${tabsId}-${tab}-panel`}
      aria-labelledby={`${tabsId}-${tab}`}
      aria-hidden={!selected}
      inert={!selected}
      data-feedback-queue={tab}
      className="h-full min-w-0 w-full shrink-0 overflow-x-hidden overflow-y-auto"
    >
      <div className="relative min-h-full">
        <p
          aria-hidden={!empty}
          className={cn(
            "r3-hint pointer-events-none absolute inset-x-0 top-0 px-3 py-8 text-center text-sm text-neutral-400",
            empty && "is-visible",
          )}
        >
          {tab === "resolved"
            ? "No resolved feedback."
            : "Select content to leave feedback, or add a general note."}
        </p>
        <div ref={listAnimation} data-feedback-list>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ArtifactThreads({
  detail,
  context,
  onLocate,
  onJumpRef,
  activeFeedback,
  composer,
  panelControls,
  onFocusFeedback,
  onNewNote,
  keysActive = true,
  tab: controlledTab,
  onTabChange,
}: {
  detail: ArtifactDetail;
  context: ArtifactMessageContext;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  activeFeedback?: string | null;
  composer?: ReactNode;
  panelControls?: ReactNode;
  onFocusFeedback?: (id: string) => void;
  onNewNote?: () => void;
  keysActive?: boolean;
  tab?: ArtifactFeedbackTab;
  onTabChange?: (tab: ArtifactFeedbackTab) => void;
}) {
  detail = useOptimisticArtifact(detail);
  const panel = useRef<HTMLElement>(null);
  const [localTab, setLocalTab] = useState<ArtifactFeedbackTab>("active");
  const tab = controlledTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const tabsId = useId();
  const [created, setCreated] = useState<ArtifactFeedback | null>(null);
  const showCreated = useCallback(
    (feedback: ArtifactFeedback) => {
      setCreated(feedback);
      setTab("active");
      return () => setCreated((current) => (current?.id === feedback.id ? null : current));
    },
    [setTab],
  );
  const notes = useMemo(
    () =>
      created?.artifactId === detail.id && !detail.feedback.some((note) => note.id === created.id)
        ? [...detail.feedback, created]
        : detail.feedback,
    [created, detail.id, detail.feedback],
  );
  const indicator = useFeedbackTabIndicator(tab);
  useEffect(() => {
    // Deleted threads have no reply destination. Reap only missing membership;
    // resolved and archived conversations keep their drafts.
    artifactDrafts.pruneReplies(detail.id, new Set(detail.feedback.map((note) => note.id)));
  }, [detail.id, detail.feedback]);
  const selected = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!activeFeedback || selected.current === activeFeedback) return;
    selected.current = activeFeedback;
    setTab(
      detail.feedback.find((note) => note.id === activeFeedback)?.status === "resolved"
        ? "resolved"
        : "active",
    );
  }, [activeFeedback, detail.feedback, setTab]);
  const handoff = useArtifactHandoff({ ...detail, feedback: notes });
  const { draftCount, watchers, pending, disabledReason, notice } = handoff;
  const noteOpen = useArtifactNoteOpen(detail.id);
  const wasNoteOpen = useRef(noteOpen);
  useEffect(() => {
    if (noteOpen && !wasNoteOpen.current) setTab("active");
    wasNoteOpen.current = noteOpen;
  }, [noteOpen, setTab]);
  const { active, resolved } = useMemo(
    () => ({
      active: activeArtifactFeedback(notes),
      resolved: notes.filter((note) => note.status === "resolved"),
    }),
    [notes],
  );
  const ordered = tab === "active" ? active : resolved;
  const locate = useCallback<ArtifactTargetJump>(
    (target, feedbackId) => onLocate(target, feedbackId),
    [onLocate],
  );
  const afterResolve = useCallback(
    (id: string) => {
      if (activeFeedback !== id) return;
      const at = active.findIndex((note) => note.id === id);
      const next = active[at + 1] ?? active[at - 1];
      if (next) onFocusFeedback?.(next.id);
    },
    [active, activeFeedback, onFocusFeedback],
  );
  const move = (direction: -1 | 1) => {
    const at = ordered.findIndex((note) => note.id === activeFeedback);
    const next =
      at < 0
        ? direction > 0
          ? 0
          : ordered.length - 1
        : Math.max(0, Math.min(ordered.length - 1, at + direction));
    if (ordered[next]) onFocusFeedback?.(ordered[next].id);
  };
  const action = (name: "reply" | "resolve") => {
    if (!activeFeedback) return;
    if (name === "reply") {
      const editor = panel.current?.querySelector<HTMLTextAreaElement>(
        `[data-artifact-feedback="${CSS.escape(activeFeedback)}"] [data-reply-to] textarea:not([inert] *)`,
      );
      if (editor) {
        editor.focus();
        return;
      }
    }
    panel.current
      ?.querySelector<HTMLButtonElement>(
        `[data-artifact-feedback="${CSS.escape(activeFeedback)}"] [data-feedback-action="${name}"]:not([inert] *)`,
      )
      ?.click();
  };
  const newNote = () => {
    setTab("active");
    if (onNewNote) onNewNote();
    else {
      artifactDrafts.anchor(detail.id, { kind: "artifact" });
      requestAnimationFrame(() =>
        panel.current
          ?.querySelector<HTMLTextAreaElement>(
            "[data-artifact-composer]:not([data-reply-to]) textarea:not([inert] *)",
          )
          ?.focus(),
      );
    }
  };
  // Mounted hidden panels retain draft state, but own no invisible shortcuts.
  useKeyBindings(
    keysActive
      ? {
          handOff: handoff.send,
          fbNext: () => move(1),
          fbPrev: () => move(-1),
          fbLocate: () => {
            const note = detail.feedback.find((note) => note.id === activeFeedback);
            if (note) locate(note.target, note.id);
          },
          fbReply: () => action("reply"),
          fbResolve: () => action("resolve"),
        }
      : {},
  );
  return (
    <section
      ref={panel}
      className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950"
      aria-label="Artifact feedback"
    >
      <div
        data-feedback-header
        className="flex shrink-0 flex-col gap-2 border-b border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 text-base font-semibold">Feedback</span>
            {panelControls}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              aria-label="Add general feedback"
              title="Add general feedback"
              onClick={newNote}
            >
              <CommentPlusIcon className="size-3.5" />
            </Button>
            <Button
              variant="primary"
              disabled={!!disabledReason || handoff.isPending}
              title={disabledReason ?? undefined}
              onClick={handoff.send}
            >
              {handoff.label}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div
            ref={indicator.ref}
            role="tablist"
            aria-label="Feedback status"
            className="relative flex items-center gap-1"
          >
            {indicator.style && (
              <span
                aria-hidden="true"
                data-feedback-tab-indicator
                style={indicator.style}
                className={cn(
                  "pointer-events-none absolute left-0 rounded-md transition-[transform,width] duration-150 ease-out will-change-transform motion-reduce:transition-none",
                  tab === "resolved"
                    ? "bg-success-100 dark:bg-success-950"
                    : "bg-neutral-200 dark:bg-neutral-800",
                )}
              />
            )}
            {(["active", "resolved"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                data-feedback-tab={value}
                id={`${tabsId}-${value}`}
                aria-controls={`${tabsId}-${value}-panel`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowLeft" || event.key === "Home"
                      ? "active"
                      : event.key === "ArrowRight" || event.key === "End"
                        ? "resolved"
                        : null;
                  if (!next) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setTab(next);
                  document.getElementById(`${tabsId}-${next}`)?.focus();
                }}
                className={cn(
                  "relative z-10 rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors",
                  tab === value
                    ? value === "resolved"
                      ? "text-success-800 dark:text-success-300"
                      : "text-neutral-800 dark:text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300",
                )}
              >
                {value === "active" ? `Active ${active.length}` : `Resolved ${resolved.length}`}
              </button>
            ))}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {!!draftCount && (
              <span
                title="Drafts stay in this browser until posted"
                className="shrink-0 rounded-full bg-warning-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-warning-700 dark:bg-warning-950/60 dark:text-warning-300"
              >
                ✎ {draftCount} {draftCount === 1 ? "draft" : "drafts"}
              </span>
            )}
            <span
              className="truncate text-[0.625rem] text-neutral-400"
              title={watchers[0]?.actor.sessionId ?? undefined}
            >
              {detail.working
                ? "Agent working"
                : watchers.length
                  ? "Agent listening"
                  : pending
                    ? `${pending} pending`
                    : ""}
            </span>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-clip">
        <div
          data-feedback-track
          className="flex h-full transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
          style={{ transform: tab === "active" ? "translateX(0)" : "translateX(-100%)" }}
        >
          <FeedbackCreationContext.Provider value={showCreated}>
            {(["active", "resolved"] as const).map((queue) => (
              <FeedbackQueue
                key={queue}
                tab={queue}
                tabsId={tabsId}
                selected={tab === queue}
                empty={
                  queue === "active" ? active.length === 0 && !noteOpen : resolved.length === 0
                }
              >
                {queue === "active" && noteOpen && (
                  <div key="composer" data-feedback-draft>
                    {composer ?? <ArtifactComposer artifactId={detail.id} />}
                  </div>
                )}
                {(queue === "active" ? active : resolved).map((feedback) => (
                  <ArtifactThreadCard
                    key={feedback.id}
                    feedback={feedback}
                    context={context}
                    artifactKind={detail.kind}
                    latestVersionSeq={detail.versions.at(-1)?.seq ?? null}
                    onLocate={locate}
                    onJumpRef={onJumpRef}
                    visible={tab === queue}
                    active={tab === queue && activeFeedback === feedback.id}
                    onResolved={afterResolve}
                  />
                ))}
              </FeedbackQueue>
            ))}
          </FeedbackCreationContext.Provider>
        </div>
      </div>
      {(notice || handoff.error) && (
        <p
          role={handoff.error ? "alert" : "status"}
          className={cn(
            "shrink-0 border-t border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700",
            handoff.error ? "text-red-600" : "text-neutral-500",
          )}
        >
          {handoff.error?.message ?? notice}
        </p>
      )}
    </section>
  );
}
