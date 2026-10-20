import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ArtifactComment,
  ArtifactDetail,
  ArtifactVersion,
} from "../../../shared/artifacts.ts";
import { useOptimisticArtifact } from "../artifact-thread-status.ts";
import { useArtifactClient, useArtifactUI } from "../artifact-ui-context.tsx";
import { formatBytes } from "../format-bytes.ts";
import { getLanguageTag, useTranslation } from "../i18n.ts";
import type { MessageRef } from "../markdown.ts";

import {
  Button,
  CopyMeta,
  MoreActionsButton,
  StrokeIcon,
  useEscape,
  usePopoverFocus,
} from "../ui.tsx";
import { useArtifactHandoff } from "../useArtifactHandoff.ts";
import { AgentName } from "./AgentName.tsx";
import { ArtifactActionDialog } from "./ArtifactActionDialog.tsx";
import { ArtifactDiscussionToggle } from "./ArtifactDiscussionToggle.tsx";
import { ArtifactHandoffButton } from "./ArtifactHandoffButton.tsx";
import { ArtifactHandoffNotice } from "./ArtifactHandoffNotice.tsx";
import { ArtifactKindIcon } from "./ArtifactKindIcon.tsx";
import { ArtifactPreviewSecurity } from "./ArtifactPreviewSecurity.tsx";
import { ArtifactOpenLatest, ArtifactVersionSelect } from "./ArtifactVersionSelect.tsx";
import { MessageProse } from "./Message.tsx";
import { Notification, type NotificationProps } from "./Notifications.tsx";
import { ShortcutsButton } from "./ShortcutsOverlay.tsx";
import { WorkspaceHeader } from "./WorkspaceHeader.tsx";

function ArtifactSendComments({ detail, visible }: { detail: ArtifactDetail; visible: boolean }) {
  const handoff = useArtifactHandoff(detail);
  return (
    <div className="r3-nav-handoff relative shrink-0" aria-hidden={!visible} inert={!visible}>
      <div className="r3-nav-handoff-content flex min-w-0 justify-end">
        {handoff.showAction && (
          <div className="flex shrink-0 items-center pr-2">
            <ArtifactHandoffButton handoff={handoff} active={visible} />
          </div>
        )}
      </div>
      <ArtifactHandoffNotice handoff={handoff} />
    </div>
  );
}
function ArtifactHistoryComment({
  comment,
  readOnly,
}: {
  comment: ArtifactComment;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const save = useMutation({
    mutationFn: () => artifactApi.editComment(comment.id, body),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["artifact", comment.artifactId] });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
  return (
    <div data-artifact-comment={comment.id} className="mt-1">
      {editing && !readOnly ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) save.mutate();
          }}
        >
          <textarea
            aria-label={t("header.editArchiveComment")}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="w-full resize-y rounded-none border border-neutral-300 bg-transparent p-2 dark:border-neutral-700"
          />
          <div className="mt-1 flex gap-2">
            <Button type="submit" disabled={save.isPending || !body.trim()}>
              {t("header.saveComment")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setEditing(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
          {save.error && <p role="alert">{save.error.message}</p>}
        </form>
      ) : (
        <>
          <MessageProse source={comment.body} />
          {!readOnly && (
            <Button
              variant="ghost"
              onClick={() => {
                setBody(comment.body);
                save.reset();
                setEditing(true);
              }}
            >
              {t("header.editComment")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
export function ArtifactArchiveDialog({
  artifactId,
  onCancel,
  onDone,
}: {
  artifactId: string;
  onCancel: () => void;
  onDone: (notice: Omit<NotificationProps, "onDismiss">) => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState("");
  const [operationKey] = useState(() => crypto.randomUUID());
  const request = useRef<{
    comment: { body: string };
    operationKey: string;
  } | null>(null);
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const archive = useMutation({
    mutationFn: () => {
      // A lost response retries exactly the original transition and message.
      request.current ??= {
        comment: {
          body: message,
        },
        operationKey,
      };
      return artifactApi.lifecycle(artifactId, { event: "archived", ...request.current });
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["artifact", artifactId] });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
      onDone(
        result.notification.state === "failed"
          ? {
              title: t("common.archivedButAgentNotificationFailed"),
              message: t("header.yourCommentIsSavedInTheArtifact2"),
              tone: "warning",
              details: result.notification.error,
            }
          : {
              title: t("header.artifactArchived"),
              tone: "success",
              message: result.event.comment?.body
                ? t("header.yourCommentIsSavedInTheArtifact")
                : undefined,
            },
      );
    },
  });
  return (
    <dialog
      ref={dialog}
      aria-labelledby="artifact-archive-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!archive.isPending) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          archive.mutate();
        }}
      >
        <h2 id="artifact-archive-title" className="font-semibold">
          {t("common.archiveArtifact")}
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          {t("header.optionallyLeaveAMessageForTheCurrent")}
        </p>
        <textarea
          aria-label={t("header.archiveCommentOptional")}
          placeholder={t("header.commentForTheAgentOptional")}
          rows={4}
          value={message}
          disabled={archive.isPending || request.current !== null}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="mt-4 w-full border border-neutral-300 bg-transparent p-2 text-sm max-md:text-base dark:border-neutral-700"
        />
        {archive.error && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {archive.error.message}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" disabled={archive.isPending} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={archive.isPending}>
            {archive.isPending
              ? t("header.archiving")
              : archive.error
                ? t("header.retryArchive")
                : t("header.archive")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
export function ArtifactHeader({
  detail,
  version = detail.versions.at(-1) ?? null,
  selectedVersion = version?.seq ?? null,
  onSelectVersion,
  detailsRequest,
  onJumpRef,
  commenting,
  commentingLocked,
  onToggleCommenting,
  captureRef,
  discussionVisible,
  discussionLocked,
  onToggleDiscussion,
  onOpenShortcuts,
}: {
  detail: ArtifactDetail;
  version?: ArtifactVersion | null;
  selectedVersion?: number | null;
  onSelectVersion?: (seq: number | null) => void;
  detailsRequest?: number;
  onJumpRef?: (reference: MessageRef) => void;
  commenting?: boolean;
  commentingLocked?: boolean;
  onToggleCommenting?: () => void;
  captureRef?: Ref<HTMLDivElement>;
  discussionVisible?: boolean;
  discussionLocked?: boolean;
  onToggleDiscussion?: () => void;
  onOpenShortcuts?: () => void;
}) {
  const { t } = useTranslation();
  const { chrome } = useArtifactUI();
  detail = useOptimisticArtifact(detail);
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  usePopoverFocus(detailsOpen, details, detailsTrigger);
  useEffect(() => {
    if (detailsRequest) setDetailsOpen(true);
  }, [detailsRequest]);
  useEscape(detailsOpen, () => setDetailsOpen(false));
  const [title, setTitle] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const editingTitle = title !== null;
  useEffect(() => {
    if (detailsOpen) (editingTitle ? titleInput : titleButton).current?.focus();
  }, [editingTitle, detailsOpen]);
  const [notice, setNotice] = useState<Omit<NotificationProps, "onDismiss"> | null>(null);
  const restoreKey = useRef<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["artifact", detail.id] });
    void qc.invalidateQueries({ queryKey: ["artifacts"] });
  };
  const edit = useMutation({
    mutationFn: () => artifactApi.edit(detail.id, { title: title ?? "" }),
    onSuccess: () => {
      setTitle(null);
      refresh();
    },
  });
  const restore = useMutation({
    mutationFn: () => {
      restoreKey.current ??= crypto.randomUUID();
      return artifactApi.lifecycle(detail.id, {
        event: "restored",
        operationKey: restoreKey.current,
      });
    },
    onSuccess: () => {
      restoreKey.current = null;
      refresh();
      setNotice({
        title: t("header.artifactRestored"),
        message: t("header.anAgentCanRegisterANewListener"),
        tone: "success",
      });
    },
  });
  const error = edit.error ?? restore.error;
  const latest = detail.versions.at(-1);
  const workingThreads = detail.threads.filter((thread) => thread.claim);
  const workingAgents = [...new Set(workingThreads.map((thread) => thread.claim!.sessionId))];
  const workingDescription = `${t("header.onThreadPlural", { agents: t("header.workingAgent", { count: workingAgents.length }), count: workingThreads.length })}\n${workingAgents
    .map(
      (id) =>
        (detail.agentLabels && Object.hasOwn(detail.agentLabels, id) && detail.agentLabels[id]) ||
        id,
    )
    .join(", ")}`;
  const header = chrome?.header ?? ((children) => <WorkspaceHeader>{children}</WorkspaceHeader>);
  return header(
    <>
      <ArtifactKindIcon kind={detail.kind} />
      <div className="flex min-w-0 items-center self-stretch">
        <span
          className="min-w-0 truncate pr-2 text-sm font-semibold"
          title={detail.title || detail.id}
        >
          {detail.title || detail.id}
        </span>
        {onSelectVersion && (
          <div className="flex shrink-0 self-stretch max-md:hidden">
            <ArtifactVersionSelect
              versions={detail.versions}
              selected={selectedVersion}
              onChange={onSelectVersion}
            />
            <ArtifactOpenLatest
              latest={latest?.seq}
              selected={selectedVersion}
              onOpen={onSelectVersion}
              className="ml-2 self-center"
            />
          </div>
        )}
      </div>
      {detail.state === "archived" && (
        <span className="shrink-0 rounded border border-warning-600/30 bg-warning-50 px-1.5 py-0.5 text-[0.625rem] font-medium text-warning-800 dark:border-warning-400/30 dark:bg-warning-400/10 dark:text-warning-300">
          {t("common.archived")}
        </span>
      )}
      <div className="min-w-0 flex-1" />
      {onToggleDiscussion && (
        <div className="flex shrink-0 items-center max-md:hidden">
          <ArtifactSendComments detail={detail} visible={!discussionVisible} />
          {workingThreads.length > 0 && (
            <span
              role="img"
              aria-label={workingDescription}
              title={workingDescription}
              data-agent-working
              className="mr-2 flex size-7 shrink-0 items-center justify-center text-primary-600 dark:text-primary-400"
            >
              <StrokeIcon className="size-4">
                <path d="M12 3v3M9 3h3M3 11v6M21 11v6" />
                <rect x="6" y="6" width="12" height="14" rx="3" />
                <path d="M9 11v2M15 11v2M10 16h4" />
              </StrokeIcon>
            </span>
          )}
          <ArtifactDiscussionToggle
            disabled={discussionLocked}
            artifactId={detail.id}
            threads={detail.threads}
            visible={!!discussionVisible}
            onToggle={onToggleDiscussion}
          />
        </div>
      )}
      {onToggleCommenting && (
        <Button
          disabled={commentingLocked}
          variant={commenting ? "primary-outline" : "nav"}
          className="h-[calc(1.75rem-2px)] w-7 shrink-0 justify-center p-0! max-md:size-9"
          aria-label={commenting ? t("header.exitCommentMode") : t("header.commentMode")}
          title={commenting ? t("header.exitCommentModeC") : t("header.commentModeC")}
          aria-pressed={commenting}
          onClick={onToggleCommenting}
        >
          <StrokeIcon className="size-4">
            <path d="M4 8V4h4M12 4h4v4M4 12v4h4" />
            <path d="m10 10 4 11 2-5 5-2-11-4Z" />
          </StrokeIcon>
        </Button>
      )}
      {detail.kind === "html" && captureRef && (
        <div
          ref={captureRef}
          data-preview-capture-slot
          className="relative shrink-0 empty:hidden"
        />
      )}
      {onOpenShortcuts && <ShortcutsButton onClick={onOpenShortcuts} />}
      <MoreActionsButton
        ref={detailsTrigger}
        aria-label={t("header.artifactDetailsAndActions")}
        title={t("header.artifactDetailsAndActions")}
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(!detailsOpen)}
      />
      {detailsOpen && (
        <button
          type="button"
          aria-label={t("header.closeArtifactDetails")}
          onClick={() => setDetailsOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      <div
        ref={details}
        role="dialog"
        hidden={!detailsOpen}
        aria-label={t("header.artifactDetails")}
        className="absolute right-2 top-full z-50 mt-1 max-h-[calc(100dvh-4rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg [overflow-wrap:anywhere] border border-neutral-300 bg-white p-3 text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      >
        <section className="mb-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          {title === null ? (
            <Button
              ref={titleButton}
              disabled={detail.state !== "active"}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                edit.reset();
                setTitle(detail.title ?? "");
              }}
            >
              {t("header.editTitle")}
            </Button>
          ) : (
            <form
              className="flex flex-col gap-2"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (!edit.isPending) {
                    setTitle(null);
                  }
                }
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (detail.state === "active") edit.mutate();
              }}
            >
              <input
                ref={titleInput}
                aria-label={t("header.artifactTitle")}
                className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2 text-sm max-md:text-base dark:border-neutral-700"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={detail.state !== "active" || edit.isPending}
              />
              <div className="flex justify-end gap-1">
                <Button type="submit" disabled={detail.state !== "active" || edit.isPending}>
                  {t("common.save")}
                </Button>
                <Button
                  type="button"
                  disabled={detail.state !== "active" || edit.isPending}
                  onClick={() => setTitle(null)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          )}
        </section>
        {detailsOpen && onSelectVersion && (
          <section className="mb-3 border-b border-neutral-200 pb-3 md:hidden dark:border-neutral-800">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium text-neutral-500">{t("header.version")}</h2>
              <ArtifactOpenLatest
                latest={detail.versions.at(-1)?.seq}
                selected={selectedVersion}
                onOpen={(seq) => {
                  onSelectVersion(seq);
                  setDetailsOpen(false);
                }}
              />
            </div>
            <ArtifactVersionSelect
              versions={detail.versions}
              selected={selectedVersion}
              inline
              onChange={(seq) => {
                onSelectVersion(seq);
                setDetailsOpen(false);
              }}
            />
          </section>
        )}
        {chrome?.settings && (
          <Button
            variant="ghost"
            className="mb-2 w-full justify-between"
            aria-haspopup="dialog"
            onClick={() => {
              setDetailsOpen(false);
              setSettingsOpen(true);
            }}
          >
            {t("settings.title")}
            <StrokeIcon className="size-4">
              <path d="m9 6 6 6-6 6" />
            </StrokeIcon>
          </Button>
        )}
        <ArtifactPreviewSecurity />
        <section
          aria-label={t("header.storageUsed")}
          className="mb-3 border-b border-neutral-200 pb-3 text-xs dark:border-neutral-800"
        >
          <h2 className="mb-2 font-medium text-neutral-500">{t("header.storageUsed")}</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt>{t("header.total")}</dt>
            <dd
              className="text-right tabular-nums"
              title={`${detail.storage.totalBytes.toLocaleString(getLanguageTag())} bytes`}
            >
              {formatBytes(detail.storage.totalBytes)}
            </dd>
            {latest && (
              <>
                <dt>
                  {t("header.latestVersion")}
                  {latest.seq}
                </dt>
                <dd
                  className="text-right tabular-nums"
                  title={`${detail.storage.latestVersionBytes.toLocaleString(getLanguageTag())} bytes`}
                >
                  {formatBytes(detail.storage.latestVersionBytes)}
                </dd>
              </>
            )}
          </dl>
          <p className="mt-2 text-neutral-500 dark:text-neutral-400">
            {t("header.publishedContentIncludingRetainedRenderingsSharedBytes")}
          </p>
        </section>
        {version?.summary && (
          <section className="mb-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
            <h2 className="mb-2 text-xs font-medium text-neutral-500">
              {t("common.descriptionVersion", { version_seq: version.seq })}
            </h2>
            <MessageProse
              source={version.summary}
              onJumpRef={
                onJumpRef &&
                ((reference) => {
                  setDetailsOpen(false);
                  onJumpRef(reference);
                })
              }
            />
          </section>
        )}
        <details className="mt-1 text-xs text-neutral-500">
          <summary className="cursor-pointer">{t("header.details")}</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <CopyMeta hint={t("header.copyArtifactId")} value={detail.id}>
              {detail.id}
            </CopyMeta>
            {detail.createdBy.role === "agent" && (
              <CopyMeta hint={t("header.copyPublisherSession")} value={detail.createdBy.sessionId}>
                {t("header.publisher")}
                <AgentName id={detail.createdBy.sessionId} labels={detail.agentLabels} />
              </CopyMeta>
            )}
            {Object.entries(detail.meta).map(([key, value]) => (
              <CopyMeta key={key} hint={t("header.copy", { key })} value={value}>
                {key}: {value}
              </CopyMeta>
            ))}
          </div>
        </details>
        {detail.events.length > 0 && (
          <details className="mt-2 text-xs text-neutral-500">
            <summary className="cursor-pointer">
              {t("common.lifecycleHistory", { detail_events_length: detail.events.length })}
            </summary>
            <ol className="mt-2 space-y-2">
              {detail.events.map((event) => (
                <li
                  key={event.id}
                  className="border-l-2 border-neutral-200 pl-2 dark:border-neutral-700"
                >
                  <div>
                    {event.event === "archived" ? t("common.archived") : t("common.restored")} ·{" "}
                    <time dateTime={event.createdAt}>
                      {new Date(event.createdAt).toLocaleString(getLanguageTag())}
                    </time>
                  </div>
                  {event.comment && (
                    <ArtifactHistoryComment
                      comment={event.comment}
                      readOnly={detail.state === "archived"}
                    />
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
        <div className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          {detail.state === "active" ? (
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                setDetailsOpen(false);
                setArchiveOpen(true);
              }}
            >
              {t("common.archiveArtifact")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="w-full justify-start"
              disabled={restore.isPending}
              onClick={() => {
                setDetailsOpen(false);
                restore.mutate();
              }}
            >
              {t("header.restoreArtifact")}
            </Button>
          )}
          <Button
            variant="ghost"
            className="w-full justify-start text-danger-600!"
            onClick={() => {
              setDetailsOpen(false);
              setDeleteOpen(true);
            }}
          >
            {t("common.deleteArtifact")}
          </Button>
        </div>
      </div>
      {notice && <Notification {...notice} onDismiss={() => setNotice(null)} />}
      {error && (
        <Notification
          title={t("header.couldNotUpdateArtifact")}
          message={error.message}
          tone="error"
          onDismiss={() => {
            edit.reset();
            restore.reset();
          }}
        />
      )}
      {settingsOpen &&
        chrome?.settings?.({ onClose: () => setSettingsOpen(false), trigger: detailsTrigger })}
      {deleteOpen && (
        <ArtifactActionDialog
          items={[detail]}
          action="delete"
          onClose={() => {
            setDeleteOpen(false);
            detailsTrigger.current?.focus();
          }}
          onDone={(results) => {
            setDeleteOpen(false);
            const failure = results.find((result) => result.state === "failed");
            if (failure)
              setNotice({
                title: t("header.couldNotDeleteArtifact"),
                message: failure.warning,
                tone: "error",
              });
            else chrome?.onDeleted?.();
          }}
        />
      )}
      {archiveOpen && (
        <ArtifactArchiveDialog
          artifactId={detail.id}
          onCancel={() => setArchiveOpen(false)}
          onDone={(text) => {
            setArchiveOpen(false);
            setNotice(text);
          }}
        />
      )}
    </>,
  );
}
