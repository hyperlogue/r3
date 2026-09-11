import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactFeedbackTargetLabel,
  artifactTargetLabel,
} from "../../../shared/artifact-prompt.ts";
import {
  type ArtifactDetail,
  type ArtifactFeedback,
  type ArtifactMessageContext,
  type ArtifactTarget,
  hasUnsentArtifactFeedback,
} from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { copyText } from "../clipboard.ts";
import type { MessageRef } from "../markdown.ts";
import { Button, cn } from "../ui.tsx";
import { ArtifactComposer } from "./ArtifactComposer.tsx";
import { MessageProse } from "./Message.tsx";

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

export const ArtifactThreadCard = memo(function ArtifactThreadCard({
  feedback,
  context,
  onLocate,
  onJumpRef,
  active = false,
}: {
  feedback: ArtifactFeedback;
  context: ArtifactMessageContext;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  active?: boolean;
}) {
  const qc = useQueryClient();
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) element.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<{ replyId?: string; body: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
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
  const status = useMutation({
    mutationFn: () =>
      artifactApi.editFeedback(feedback.id, {
        status: feedback.status === "open" ? "resolved" : "open",
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => artifactApi.deleteFeedback(feedback.id),
    onSuccess: refresh,
  });
  const unavailable = artifactFeedbackTargetLabel(feedback) === "Historical target unavailable";
  const originalContext = targetContext(feedback.target);
  const quote =
    "locator" in feedback.target && feedback.target.locator && "quote" in feedback.target.locator
      ? feedback.target.locator.quote
      : null;
  const error = edit.error ?? status.error ?? remove.error;
  return (
    <article
      ref={element}
      data-artifact-feedback={feedback.id}
      className={cn(
        "relative rounded-lg border p-3 text-sm",
        feedback.status === "resolved"
          ? "border-success-500/30 bg-success-500/10"
          : "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950",
        feedback.claim && "bg-neutral-100/70 dark:bg-neutral-900/70",
        active && "ring-2 ring-primary-500",
      )}
    >
      {feedback.claim && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-lg bg-neutral-500/10"
        />
      )}
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2 text-xs">
        {unavailable ? (
          <span className="text-amber-700 dark:text-amber-400">Historical target unavailable</span>
        ) : (
          <button
            type="button"
            className="min-w-0 break-all text-left text-primary-700 underline-offset-2 hover:underline dark:text-primary-300"
            onClick={() => onLocate(feedback.target, feedback.id)}
          >
            {artifactFeedbackTargetLabel(feedback)}
          </button>
        )}
        {feedback.status === "resolved" && (
          <span className="rounded bg-success-500/15 px-1.5 py-0.5 font-semibold text-success-700 dark:text-success-300">
            ✓ resolved
          </span>
        )}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span title={feedback.author.sessionId ?? undefined}>
          {feedback.author.role === "human"
            ? "You"
            : `Agent · ${feedback.author.sessionId.slice(0, 20)}`}
        </span>
        {hasUnsentArtifactFeedback(feedback) && <span>Not submitted</span>}
        {feedback.claim && (
          <span
            className="relative z-20 rounded bg-primary-500/15 px-1.5 py-0.5 text-primary-700 dark:text-primary-300"
            title={`Working agent: ${feedback.claim.sessionId}`}
          >
            Working · {feedback.claim.sessionId.slice(0, 16)}
          </span>
        )}
      </div>
      {quote && (
        <blockquote className="mb-2 max-h-28 overflow-auto border-l-2 border-neutral-300 pl-2 text-xs text-neutral-500 whitespace-pre-wrap">
          {quote}
        </blockquote>
      )}
      {unavailable && (
        <details className="mb-2 text-xs text-neutral-500">
          <summary>Imported anchor evidence</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(feedback.legacy?.source, null, 2)}
          </pre>
        </details>
      )}
      <MessageProse source={feedback.body} onJumpRef={(ref) => onJumpRef(ref, originalContext)} />
      {feedback.replies.map((reply) => (
        <div
          key={reply.id}
          className="mt-3 border-l-2 border-neutral-200 pl-3 dark:border-neutral-700"
        >
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span title={reply.author.sessionId ?? undefined}>
              {reply.author.role === "human"
                ? "You"
                : `Agent · ${reply.author.sessionId.slice(0, 20)}`}
            </span>
            {reply.context.versionSeq !== null && (
              <span>
                Version {reply.context.versionSeq}
                {reply.context.representation ? ` · ${reply.context.representation}` : ""}
              </span>
            )}
            {reply.author.role === "human" && (
              <button
                type="button"
                className="ml-auto underline"
                onClick={() => setEditing({ replyId: reply.id, body: reply.body })}
              >
                Edit
              </button>
            )}
          </div>
          <MessageProse source={reply.body} onJumpRef={(ref) => onJumpRef(ref, reply.context)} />
          {reply.target && (
            <button
              type="button"
              className="mt-2 text-left text-xs text-primary-700 hover:underline dark:text-primary-300"
              onClick={() => onLocate(reply.target!, feedback.id)}
            >
              ↳ Fix: {artifactTargetLabel(reply.target)}
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
      {editing && (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            edit.mutate();
          }}
        >
          <textarea
            aria-label="Edit message"
            className="min-h-24 w-full rounded border border-neutral-300 bg-transparent p-2 text-sm max-md:text-base dark:border-neutral-700"
            value={editing.body}
            onChange={(event) => setEditing({ ...editing, body: event.target.value })}
            disabled={edit.isPending}
          />
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!editing.body.trim() || edit.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error.message}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          onClick={() => {
            artifactDrafts.beginReply(feedback.artifactId, feedback.id, context);
            setReplying((value) => !value);
          }}
        >
          Reply
        </Button>
        {feedback.author.role === "human" && (
          <Button variant="ghost" onClick={() => setEditing({ body: feedback.body })}>
            Edit
          </Button>
        )}
        <Button variant="ghost" onClick={() => setDeleting((value) => !value)}>
          Delete
        </Button>
        <Button
          className="ml-auto"
          variant={feedback.status === "open" ? "success" : "ghost"}
          disabled={status.isPending}
          onClick={() => status.mutate()}
        >
          {feedback.status === "open" ? "Resolve" : "Reopen"}
        </Button>
      </div>
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
        <div className="mt-3">
          <ArtifactComposer
            artifactId={feedback.artifactId}
            replyTo={feedback.id}
            onDone={() => setReplying(false)}
          />
        </div>
      )}
    </article>
  );
});

export function ArtifactThreads({
  detail,
  context,
  onLocate,
  onJumpRef,
  activeFeedback,
  composer,
  onCollapse,
}: {
  detail: ArtifactDetail;
  context: ArtifactMessageContext;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  activeFeedback?: string | null;
  composer?: ReactNode;
  onCollapse?: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  useEffect(() => {
    if (activeFeedback) setFilter("all");
  }, [activeFeedback]);
  const [notice, setNotice] = useState("");
  const qc = useQueryClient();
  const { data: watchers = [] } = useQuery({
    queryKey: ["artifact-watchers", detail.id],
    queryFn: () => artifactApi.watchers(detail.id),
  });
  const { open, resolved, pending, ordered } = useMemo(() => {
    const open = detail.feedback.filter((feedback) => feedback.status === "open");
    const resolved = detail.feedback.filter((feedback) => feedback.status === "resolved");
    const selected = filter === "all" ? detail.feedback : filter === "resolved" ? resolved : open;
    return {
      open,
      resolved,
      pending: detail.feedback.filter(hasUnsentArtifactFeedback).length,
      ordered: [...selected].sort((a, b) => Number(!!a.claim) - Number(!!b.claim)),
    };
  }, [detail.feedback, filter]);
  const handoff = useMutation({
    mutationFn: async () => {
      setNotice("");
      if (watchers.length) {
        await artifactApi.submit(detail.id);
        setNotice("Submitted to the waiting agent.");
      } else {
        const preview = await artifactApi.previewPrompt(detail.id);
        if (!(await copyText(preview.text)))
          throw new Error("Clipboard access failed. Feedback remains unsubmitted.");
        await artifactApi.acknowledgePrompt(detail.id, preview.fingerprint);
        setNotice("Prompt copied. Paste it into your agent conversation.");
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["artifact", detail.id] }),
  });
  const locate = useCallback<ArtifactTargetJump>(
    (target, feedbackId) => onLocate(target, feedbackId),
    [onLocate],
  );
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-neutral-50 dark:bg-neutral-900"
      aria-label="Artifact feedback"
    >
      <div className="shrink-0 border-b border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Feedback · {open.length} open</span>
          {onCollapse && (
            <Button variant="ghost" aria-label="Collapse feedback" onClick={onCollapse}>
              ›
            </Button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1">
          {(["open", "resolved", "all"] as const).map((value) => (
            <Button
              key={value}
              variant={filter === value ? "default" : "ghost"}
              className={
                value === "resolved" && filter === value
                  ? "text-success-700 dark:text-success-300"
                  : ""
              }
              onClick={() => setFilter(value)}
            >
              {value === "open"
                ? `Open ${open.length}`
                : value === "resolved"
                  ? `Resolved ${resolved.length}`
                  : "All"}
            </Button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {ordered.length === 0 && (
          <p className="py-6 text-center text-sm text-neutral-500">
            {filter === "resolved" ? "No resolved feedback." : "No feedback here yet."}
          </p>
        )}
        {ordered.map((feedback) => (
          <ArtifactThreadCard
            key={feedback.id}
            feedback={feedback}
            context={context}
            onLocate={locate}
            onJumpRef={onJumpRef}
            active={activeFeedback === feedback.id}
          />
        ))}
      </div>
      <div className="shrink-0 space-y-2 border-t border-neutral-300 p-3 dark:border-neutral-700">
        {composer ?? <ArtifactComposer artifactId={detail.id} />}
        {notice && (
          <p role="status" className="text-xs text-neutral-500">
            {notice}
          </p>
        )}
        {handoff.error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {handoff.error.message}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-all text-xs text-neutral-500">
            {watchers.length
              ? `${watchers[0].actor.sessionId} ${watchers[0].kind === "listen" ? "listening" : "watching"}`
              : `${pending} unsubmitted`}
          </span>
          <Button
            variant="primary"
            disabled={detail.state === "archived" || !pending || handoff.isPending}
            onClick={() => handoff.mutate()}
          >
            {handoff.isPending ? "Sending…" : watchers.length ? "Submit" : "Copy prompt"}
          </Button>
        </div>
      </div>
    </section>
  );
}
