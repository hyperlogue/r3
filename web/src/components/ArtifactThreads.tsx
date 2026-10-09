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
  artifactDiscussionTargetLabel,
  artifactTargetLabel,
} from "../../../shared/artifact-prompt.ts";
import {
  type ArtifactDetail,
  type ArtifactDiscussion,
  type ArtifactKind,
  type ArtifactReferenceContext,
  type ArtifactTarget,
  hasUnsentArtifactDiscussion,
} from "../../../shared/artifacts.ts";
import { hasMessageContent } from "../../../shared/attachments.ts";
import type { ArtifactComparison } from "../artifact-comparison.ts";
import { activeArtifactDiscussion, artifactNeedsAttention } from "../artifact-discussions.ts";
import { useDiscussionStatus, useOptimisticArtifact } from "../artifact-discussions-status.ts";
import { artifactDrafts, useArtifactNoteOpen } from "../artifact-drafts.ts";
import { useArtifactClient } from "../artifact-ui-context.tsx";
import {
  DiscussionCreationContext,
  discussionAnimation,
  useDiscussionTabIndicator,
} from "../discussions-motion.ts";
import { type ImageInsertion, imageMessageBody } from "../image-placeholders.ts";
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
import { AgentName } from "./AgentName.tsx";
import { ArtifactComposer } from "./ArtifactComposer.tsx";
import { ArtifactHandoffButton } from "./ArtifactHandoffButton.tsx";
import { ArtifactHandoffNotice } from "./ArtifactHandoffNotice.tsx";
import { MediaTargetPreview } from "./MediaTargetPreview.tsx";
import { MessageProse, QuoteBubble, useQuoteBubble } from "./Message.tsx";
import {
  type EditableImage,
  editableImageInputs,
  MessageAttachments,
  useAttachmentInput,
} from "./MessageAttachments.tsx";
import { MessageInput } from "./MessageInput.tsx";
export type ArtifactRefJump = (reference: MessageRef, context: ArtifactReferenceContext) => void;
export type ArtifactTargetJump = (target: ArtifactTarget, discussionId?: string) => void;
function targetContext(target: ArtifactTarget): ArtifactReferenceContext {
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
function DiscussionQuote({ quote }: { quote: string }) {
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
  discussions,
  agentLabels,
  artifactKind,
  latestVersionSeq,
  onLocate,
  onJumpRef,
  active = false,
  activeCommentId,
  visible = true,
  onResolved,
  comparisons,
  onCompare,
  hidden = false,
  readOnly = false,
}: {
  discussions: ArtifactDiscussion;
  agentLabels?: ArtifactDetail["agentLabels"];
  context: ArtifactReferenceContext;
  artifactKind: ArtifactKind;
  latestVersionSeq: number | null;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  active?: boolean;
  activeCommentId?: string | null;
  visible?: boolean;
  onResolved?: (id: string) => void;
  comparisons?: ReadonlyMap<string, ArtifactComparison>;
  onCompare?: (commentId: string) => void;
  hidden?: boolean;
  readOnly?: boolean;
}) {
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  const element = useRef<HTMLElement>(null);
  const [earlierOpen, setEarlierOpen] = useState(!!activeCommentId);
  useEffect(() => {
    if (active && activeCommentId) setEarlierOpen(true);
  }, [active, activeCommentId]);
  useEffect(() => {
    if (!active || !visible) return;
    const comment =
      earlierOpen && activeCommentId
        ? element.current?.querySelector(`[data-artifact-comment="${CSS.escape(activeCommentId)}"]`)
        : null;
    (comment ?? element.current)?.scrollIntoView({ block: "nearest" });
  }, [active, activeCommentId, visible, earlierOpen]);
  const [commenting, setCommenting] = useState(false);
  const [editing, setEditing] = useState<{
    commentId?: string;
    body: string;
    attachments: EditableImage[];
  } | null>(null);
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
  useEscape(menuOpen, () => setMenuOpen(false));
  const lastComment = discussions.comments.slice(1).at(-1);
  const canEdit = (lastComment?.author ?? discussions.comments[0]!.author).role === "human";
  const openComment = () => {
    artifactDrafts.beginComment(discussions.artifactId, discussions.id, originalContext);
    setCommenting(true);
    requestAnimationFrame(() => {
      const input = element.current?.querySelector<HTMLTextAreaElement>(
        "[data-comment-to] textarea",
      );
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollTop = input.scrollHeight;
    });
  };
  const bubble = useQuoteBubble(element, (range) => {
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return !readOnly && visible && !!element?.closest('[data-message-author="agent"]');
  });
  useEffect(() => {
    if (!visible) {
      setMenuOpen(false);
      bubble.hide();
    }
  }, [visible, bubble.hide]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["artifact", discussions.artifactId] });
  const edit = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const attachments = await editableImageInputs(editing.attachments);
      if (editing.commentId)
        await artifactApi.editComment(editing.commentId, editing.body, attachments);
      else await artifactApi.editDiscussion(discussions.id, { body: editing.body, attachments });
    },
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
  });
  const editTextarea = useRef<HTMLTextAreaElement>(null);
  const changeImages = (
    change: (images: EditableImage[]) => EditableImage[],
    insertion?: ImageInsertion,
  ) =>
    setEditing((held) => {
      if (!held) return null;
      const attachments = change(held.attachments);
      return {
        ...held,
        attachments,
        body: imageMessageBody(held.body, held.attachments, attachments, insertion),
      };
    });
  const attachmentInput = useAttachmentInput(
    discussions.artifactId,
    editing?.attachments ?? [],
    changeImages,
    edit.isPending,
    editTextarea,
  );
  const status = useDiscussionStatus(discussions);
  const remove = useMutation({
    mutationFn: () => artifactApi.deleteDiscussion(discussions.id),
    onSuccess: refresh,
  });
  const unavailable =
    artifactDiscussionTargetLabel(discussions) === "Historical target unavailable";
  const hasTarget = unavailable || discussions.target.kind !== "artifact";
  const originalContext = targetContext(discussions.target);
  const quote =
    "locator" in discussions.target &&
    discussions.target.locator &&
    "quote" in discussions.target.locator
      ? discussions.target.locator.quote
      : null;
  const error = edit.error ?? status.error ?? remove.error;
  const resolveButton = (
    <Button
      type="button"
      data-discussions-action="resolve"
      variant={discussions.status === "open" ? "success-outline" : "ghost"}
      disabled={status.isPending}
      className={discussions.status === "resolved" ? "text-neutral-400" : undefined}
      onClick={() => {
        status.change(discussions.status === "open" ? "resolved" : "open");
        if (discussions.status === "open") onResolved?.(discussions.id);
      }}
    >
      {discussions.status === "open" ? "✓ Resolve" : "Reopen"}
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
            aria-label="Discussion actions"
            className="absolute top-full left-0 z-50 mt-1 w-28 overflow-hidden rounded-md border border-neutral-300 bg-white r3-popover dark:border-neutral-700 dark:bg-neutral-950"
          >
            <button
              type="button"
              disabled={!canEdit}
              title={canEdit ? undefined : "The agent replied last — post a new comment instead"}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100 disabled:text-neutral-400 dark:hover:bg-neutral-800"
              onClick={() => {
                setEditing(
                  lastComment
                    ? {
                        commentId: lastComment.id,
                        body: lastComment.body,
                        attachments: lastComment.attachments ?? [],
                      }
                    : {
                        body: discussions.comments[0]!.body,
                        attachments: discussions.comments[0]!.attachments ?? [],
                      },
                );
                setMenuOpen(false);
                setCommenting(false);
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
  const editForm = !readOnly && editing && (
    <form
      data-edit-message
      onPaste={attachmentInput.onPaste}
      className="-mx-3 flex flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasMessageContent(editing) && !attachmentInput.unfinished && !edit.isPending)
          edit.mutate();
      }}
    >
      <MessageInput
        inputRef={editTextarea}
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
      <div className="px-3">
        <MessageAttachments
          artifactId={discussions.artifactId}
          images={editing.attachments}
          onChange={changeImages}
          disabled={edit.isPending}
        />
      </div>
      {attachmentInput.notice && (
        <p role="status" className="px-3 text-xs text-amber-700">
          {attachmentInput.notice}
        </p>
      )}
      <div className="flex justify-end gap-2 px-3">
        {attachmentInput.controls}
        <Button type="button" disabled={edit.isPending} onClick={() => setEditing(null)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!hasMessageContent(editing) || attachmentInput.unfinished || edit.isPending}
        >
          {edit.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
  return (
    <article
      ref={element}
      data-artifact-discussions={discussions.id}
      hidden={hidden}
      inert={hidden}
      className={cn(
        "relative border-b border-neutral-200 px-3 py-3 text-sm dark:border-neutral-800",
        discussions.status === "resolved"
          ? "bg-success-50/60 dark:bg-success-950/20"
          : "bg-white dark:bg-neutral-950",
        discussions.claim && "bg-neutral-100/70 dark:bg-neutral-900/70",
        active &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-warning-500",
      )}
    >
      {discussions.claim && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-neutral-500/10"
        />
      )}
      {(hasTarget || artifactNeedsAttention(discussions) || discussions.status === "resolved") && (
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2 text-xs">
          {artifactNeedsAttention(discussions) && (
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
              title={artifactDiscussionTargetLabel(discussions)}
              onClick={() => onLocate(discussions.target, discussions.id)}
            >
              {cardTargetLabel(discussions.target, latestVersionSeq)}
            </button>
          ) : null}
          {discussions.status === "resolved" && (
            <span className="rounded bg-success-500/15 px-1.5 py-0.5 font-semibold text-success-700 dark:text-success-300">
              ✓ resolved
            </span>
          )}
        </div>
      )}
      {discussions.target.kind === "media" && discussions.target.locator.frame && (
        <MediaTargetPreview
          image={discussions.target.locator.frame}
          box={discussions.target.locator.box}
        />
      )}
      {(hasUnsentArtifactDiscussion(discussions) || discussions.claim) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {hasUnsentArtifactDiscussion(discussions) && <span>Not sent</span>}
          {discussions.claim && (
            <span
              className="relative z-20 rounded bg-primary-500/15 px-1.5 py-0.5 text-primary-700 dark:text-primary-300"
              title={`Working agent: ${discussions.claim.sessionId}`}
            >
              Working · <AgentName id={discussions.claim.sessionId} labels={agentLabels} />
            </span>
          )}
        </div>
      )}
      {quote && <DiscussionQuote quote={quote} />}
      {unavailable && (
        <details className="mb-2 text-xs text-neutral-500">
          <summary>Imported anchor evidence</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(discussions.comments[0]!.legacy?.source, null, 2)}
          </pre>
        </details>
      )}
      <div
        data-message-author={discussions.comments[0]!.author.role}
        className={cn(
          discussions.comments[0]!.author.role === "agent" &&
            "rounded-md bg-primary-100/60 px-2.5 py-1.5 dark:bg-primary-500/15",
        )}
      >
        {discussions.comments[0]!.author.role === "agent" && (
          <div
            className="mb-1 text-xs text-neutral-500"
            title={discussions.comments[0]!.author.sessionId}
          >
            Agent ·{" "}
            <AgentName id={discussions.comments[0]!.author.sessionId} labels={agentLabels} />
          </div>
        )}
        {!readOnly && editing && !editing.commentId ? (
          editForm
        ) : (
          <MessageProse
            source={discussions.comments[0]!.body}
            onJumpRef={(ref) => onJumpRef(ref, originalContext)}
          />
        )}
        {(readOnly || !(editing && !editing.commentId)) && (
          <MessageAttachments
            artifactId={discussions.artifactId}
            images={discussions.comments[0]!.attachments}
          />
        )}
      </div>
      {discussions.comments.slice(1).length > 3 && (
        <button
          type="button"
          className="mt-2.5 flex items-center gap-1 text-[0.6875rem] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          onClick={() => setEarlierOpen((value) => !value)}
        >
          <FoldTriangle open={earlierOpen} className="size-2.5" />
          {earlierOpen
            ? "hide earlier comments"
            : `${discussions.comments.slice(1).length - 3} earlier comments`}
        </button>
      )}
      {(earlierOpen ? discussions.comments.slice(1) : discussions.comments.slice(1).slice(-3)).map(
        (comment) => (
          <div
            key={comment.id}
            data-artifact-comment={comment.id}
            data-message-author={comment.author.role}
            className={cn(
              "mt-2.5",
              comment.author.role === "agent" &&
                "rounded-md bg-primary-100/60 px-2.5 py-1.5 dark:bg-primary-500/15",
            )}
          >
            {comment.author.role === "agent" && (
              <div className="mb-1 text-xs text-neutral-500" title={comment.author.sessionId}>
                Agent · <AgentName id={comment.author.sessionId} labels={agentLabels} />
              </div>
            )}
            {!readOnly && editing?.commentId === comment.id ? (
              editForm
            ) : (
              <MessageProse
                source={comment.body}
                onJumpRef={(ref) => onJumpRef(ref, comment.context)}
              />
            )}
            {(readOnly || editing?.commentId !== comment.id) && (
              <MessageAttachments
                artifactId={discussions.artifactId}
                images={comment.attachments}
              />
            )}
            {comment.target && (
              <button
                type="button"
                className="mt-2 text-left text-xs text-primary-700 hover:underline dark:text-primary-300"
                title={
                  artifactKind === "html" && comment.target.kind === "rendered"
                    ? `Version ${comment.target.versionSeq} · ${comment.target.locator?.selector ?? "Page"}`
                    : artifactTargetLabel(comment.target)
                }
                onClick={() => onLocate(comment.target!, discussions.id)}
              >
                ↳ Fix: {fixTargetLabel(comment.target, latestVersionSeq, artifactKind)}
              </button>
            )}
            {comment.target?.kind === "media" && comment.target.locator.frame && (
              <MediaTargetPreview
                image={comment.target.locator.frame}
                box={comment.target.locator.box}
              />
            )}
            {onCompare && comparisons?.has(comment.id) && (
              <Button
                className="ml-2 mt-2"
                variant="primary-outline"
                data-compare-comment={comment.id}
                onClick={() => onCompare(comment.id)}
              >
                Compare
              </Button>
            )}
            {comment.legacy && (
              <details className="mt-1 text-xs text-neutral-500">
                <summary>Imported reference evidence</summary>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(comment.legacy, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ),
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error.message}
        </p>
      )}
      {!readOnly && !editing && !commenting && (
        <div className="mt-3 flex items-center gap-1 text-[0.6875rem]">
          {resolveButton}
          {moreMenu}
          <Button className="ml-auto" data-discussions-action="comment" onClick={openComment}>
            Comment
          </Button>
        </div>
      )}
      {!readOnly && deleting && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>Delete this thread and its comments?</span>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete thread
          </Button>
          <Button onClick={() => setDeleting(false)}>Keep</Button>
        </div>
      )}
      {!readOnly && commenting && (
        <div className="-mx-3 mt-3">
          <ArtifactComposer
            artifactId={discussions.artifactId}
            commentTo={discussions.id}
            onDone={() => setCommenting(false)}
          />
        </div>
      )}
      {!readOnly && visible && bubble.pos && (
        <QuoteBubble
          pos={bubble.pos}
          label="Quote in comment"
          onQuote={(text) => {
            openComment();
            const draft = artifactDrafts.get(discussions.artifactId, discussions.id);
            const body = draft?.body ?? "";
            artifactDrafts.update(
              discussions.artifactId,
              {
                body: `${body.trim() ? `${body}\n\n` : ""}${text
                  .split("\n")
                  .map((line) => `> ${line}`)
                  .join("\n")}\n\n`,
              },
              discussions.id,
            );
            bubble.hide();
          }}
        />
      )}
    </article>
  );
});
export type ArtifactDiscussionTab = "active" | "resolved";
// Each queue owns its scroll position and row animation. Switching tabs changes
// only the track transform, so cards, comment editors, and the Active draft survive.
function DiscussionQueue({
  tab,
  selected,
  tabsId,
  empty,
  children,
}: {
  tab: ArtifactDiscussionTab;
  selected: boolean;
  tabsId: string;
  empty: boolean;
  children: ReactNode;
}) {
  const [listAnimation] = useAutoAnimate<HTMLDivElement>(discussionAnimation);
  return (
    <div
      role="tabpanel"
      id={`${tabsId}-${tab}-panel`}
      aria-labelledby={`${tabsId}-${tab}`}
      aria-hidden={!selected}
      inert={!selected}
      data-discussions-queue={tab}
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
            ? "No resolved discussions."
            : "Select content to leave discussions, or add a general note."}
        </p>
        <div ref={listAnimation} data-discussions-list>
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
  activeDiscussion,
  activeCommentId,
  composer,
  panelControls,
  onFocusDiscussion,
  onNewNote,
  comparisons,
  onCompare,
  comparisonMode = false,
  keysActive = true,
  tab: controlledTab,
  onTabChange,
}: {
  detail: ArtifactDetail;
  context: ArtifactReferenceContext;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  activeDiscussion?: string | null;
  activeCommentId?: string | null;
  composer?: ReactNode;
  panelControls?: ReactNode;
  onFocusDiscussion?: (id: string) => void;
  onNewNote?: () => void;
  comparisons?: ReadonlyMap<string, ArtifactComparison>;
  onCompare?: (commentId: string) => void;
  comparisonMode?: boolean;
  keysActive?: boolean;
  tab?: ArtifactDiscussionTab;
  onTabChange?: (tab: ArtifactDiscussionTab) => void;
}) {
  detail = useOptimisticArtifact(detail);
  const panel = useRef<HTMLElement>(null);
  const [localTab, setLocalTab] = useState<ArtifactDiscussionTab>("active");
  const tab = controlledTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const tabsId = useId();
  const [created, setCreated] = useState<ArtifactDiscussion | null>(null);
  const showCreated = useCallback(
    (discussions: ArtifactDiscussion) => {
      setCreated(discussions);
      setTab("active");
      return () => setCreated((current) => (current?.id === discussions.id ? null : current));
    },
    [setTab],
  );
  const notes = useMemo(
    () =>
      created?.artifactId === detail.id &&
      !detail.discussions.some((note) => note.id === created.id)
        ? [...detail.discussions, created]
        : detail.discussions,
    [created, detail.id, detail.discussions],
  );
  const indicator = useDiscussionTabIndicator(tab);
  useEffect(() => {
    // Deleted threads have no comment destination. Reap only missing membership;
    // resolved and archived conversations keep their drafts.
    artifactDrafts.pruneComments(detail.id, new Set(detail.discussions.map((note) => note.id)));
  }, [detail.id, detail.discussions]);
  const selected = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!activeDiscussion || selected.current === activeDiscussion) return;
    selected.current = activeDiscussion;
    setTab(
      detail.discussions.find((note) => note.id === activeDiscussion)?.status === "resolved"
        ? "resolved"
        : "active",
    );
  }, [activeDiscussion, detail.discussions, setTab]);
  const handoff = useArtifactHandoff({ ...detail, discussions: notes });
  const { draftCount, watchers, pending } = handoff;
  const noteOpen = useArtifactNoteOpen(detail.id);
  const wasNoteOpen = useRef(noteOpen);
  useEffect(() => {
    if (noteOpen && !wasNoteOpen.current) setTab("active");
    wasNoteOpen.current = noteOpen;
  }, [noteOpen, setTab]);
  const comparable = useMemo(
    () => new Set([...(comparisons?.values() ?? [])].map((pair) => pair.discussionId)),
    [comparisons],
  );
  const included = (note: ArtifactDiscussion) => !comparisonMode || comparable.has(note.id);
  const queues = useMemo(
    () => ({
      active: activeArtifactDiscussion(notes),
      resolved: notes.filter((note) => note.status === "resolved"),
    }),
    [notes],
  );
  const { active, resolved } = useMemo(() => {
    const included = (note: ArtifactDiscussion) => !comparisonMode || comparable.has(note.id);
    return { active: queues.active.filter(included), resolved: queues.resolved.filter(included) };
  }, [queues, comparable, comparisonMode]);
  const ordered = tab === "active" ? active : resolved;
  const locate = useCallback<ArtifactTargetJump>(
    (target, discussionId) => onLocate(target, discussionId),
    [onLocate],
  );
  const afterResolve = useCallback(
    (id: string) => {
      if (activeDiscussion !== id) return;
      const at = active.findIndex((note) => note.id === id);
      const next = active[at + 1] ?? active[at - 1];
      if (next) onFocusDiscussion?.(next.id);
    },
    [active, activeDiscussion, onFocusDiscussion],
  );
  const move = (direction: -1 | 1) => {
    const at = ordered.findIndex((note) => note.id === activeDiscussion);
    const next =
      at < 0
        ? direction > 0
          ? 0
          : ordered.length - 1
        : Math.max(0, Math.min(ordered.length - 1, at + direction));
    if (ordered[next]) onFocusDiscussion?.(ordered[next].id);
  };
  const action = (name: "comment" | "resolve") => {
    if (!activeDiscussion) return;
    if (name === "comment") {
      const editor = panel.current?.querySelector<HTMLTextAreaElement>(
        `[data-artifact-discussions="${CSS.escape(activeDiscussion)}"] [data-comment-to] textarea:not([inert] *)`,
      );
      if (editor) {
        editor.focus();
        return;
      }
    }
    panel.current
      ?.querySelector<HTMLButtonElement>(
        `[data-artifact-discussions="${CSS.escape(activeDiscussion)}"] [data-discussions-action="${name}"]:not([inert] *)`,
      )
      ?.click();
  };
  const newNote = () => {
    if (detail.state !== "active") return;
    setTab("active");
    if (onNewNote) onNewNote();
    else {
      artifactDrafts.anchor(detail.id, { kind: "artifact" });
      requestAnimationFrame(() =>
        panel.current
          ?.querySelector<HTMLTextAreaElement>(
            "[data-artifact-composer]:not([data-comment-to]) textarea:not([inert] *)",
          )
          ?.focus(),
      );
    }
  };
  // Mounted hidden panels retain draft state, but own no invisible shortcuts.
  useKeyBindings(
    keysActive
      ? {
          handOff: () =>
            panel.current?.querySelector<HTMLButtonElement>("[data-artifact-handoff]")?.click(),
          fbNext: () => move(1),
          fbPrev: () => move(-1),
          fbLocate: () => {
            const note = detail.discussions.find((note) => note.id === activeDiscussion);
            if (note) locate(note.target, note.id);
          },
          fbComment: () => action("comment"),
          fbResolve: () => action("resolve"),
        }
      : {},
  );
  return (
    <section
      ref={panel}
      className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950"
      aria-label="Artifact discussions"
    >
      <div
        data-discussions-header
        className="flex shrink-0 flex-col gap-2 border-b border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 text-base font-semibold">Discussion</span>
            {comparisonMode && (
              <span className="rounded-full bg-primary-100 px-2 py-0.5 text-[0.625rem] font-medium text-primary-700 dark:bg-primary-950 dark:text-primary-300">
                Comparison
              </span>
            )}
            {panelControls}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              aria-label="Add general discussions"
              title="Add general discussions (n)"
              onClick={newNote}
              disabled={detail.state !== "active"}
            >
              <CommentPlusIcon className="size-3.5" />
            </Button>
            <ArtifactHandoffButton handoff={handoff} active={keysActive} />
          </div>
        </div>
        {watchers[0]?.error && (
          <p
            role="status"
            data-subscription-error
            className="text-xs text-warning-700 dark:text-warning-300"
          >
            {watchers[0].error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div
            ref={indicator.ref}
            role="tablist"
            aria-label="Discussion status"
            className="relative flex items-center gap-1"
          >
            <span
              ref={indicator.indicatorRef}
              aria-hidden="true"
              data-discussions-tab-indicator
              className={cn(
                "pointer-events-none absolute left-0 rounded-md will-change-transform",
                tab === "resolved"
                  ? "bg-success-100 dark:bg-success-950"
                  : "bg-neutral-200 dark:bg-neutral-800",
              )}
            />
            {(["active", "resolved"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                data-discussions-tab={value}
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
              title={watchers[0]?.label ?? watchers[0]?.actor.sessionId ?? undefined}
            >
              {detail.working
                ? "Agent working"
                : watchers.length
                  ? watchers[0]?.mode === "fallback"
                    ? "Fallback registered"
                    : watchers[0]?.mode === "explicit"
                      ? "Listener registered"
                      : "Agent listening"
                  : pending
                    ? `${pending} pending`
                    : ""}
            </span>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-clip">
        <div
          data-discussions-track
          className="flex h-full transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
          style={{ transform: tab === "active" ? "translateX(0)" : "translateX(-100%)" }}
        >
          <DiscussionCreationContext.Provider value={showCreated}>
            {(["active", "resolved"] as const).map((queue) => (
              <DiscussionQueue
                key={queue}
                tab={queue}
                tabsId={tabsId}
                selected={tab === queue}
                empty={
                  queue === "active" ? active.length === 0 && !noteOpen : resolved.length === 0
                }
              >
                {queue === "active" && noteOpen && (
                  <div key="composer" data-discussions-draft>
                    {composer ?? (
                      <ArtifactComposer
                        artifactId={detail.id}
                        readOnly={detail.state !== "active"}
                      />
                    )}
                  </div>
                )}
                {(queue === "active" ? queues.active : queues.resolved).map((discussions) => (
                  <ArtifactThreadCard
                    key={discussions.id}
                    discussions={discussions}
                    readOnly={detail.state !== "active"}
                    agentLabels={detail.agentLabels}
                    context={context}
                    artifactKind={detail.kind}
                    latestVersionSeq={detail.versions.at(-1)?.seq ?? null}
                    onLocate={locate}
                    onJumpRef={onJumpRef}
                    visible={tab === queue && included(discussions)}
                    hidden={!included(discussions)}
                    comparisons={comparisons}
                    onCompare={onCompare}
                    active={tab === queue && activeDiscussion === discussions.id}
                    activeCommentId={activeDiscussion === discussions.id ? activeCommentId : null}
                    onResolved={afterResolve}
                  />
                ))}
              </DiscussionQueue>
            ))}
          </DiscussionCreationContext.Provider>
        </div>
      </div>
      <ArtifactHandoffNotice handoff={handoff} />
    </section>
  );
}
