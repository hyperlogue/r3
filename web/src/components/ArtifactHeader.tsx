import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactDetail, ArtifactVersion } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { useOptimisticArtifact } from "../artifact-feedback-status.ts";
import type { MessageRef } from "../markdown.ts";
import { Button, CopyMeta, Pill, StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { ArtifactFeedbackToggle } from "./ArtifactFeedbackToggle.tsx";
import { ArtifactKindIcon } from "./ArtifactKindIcon.tsx";
import { ArtifactPreviewSecurity } from "./ArtifactPreviewSecurity.tsx";
import { ArtifactOpenLatest, ArtifactVersionSelect } from "./ArtifactVersionSelect.tsx";
import { MessageProse } from "./Message.tsx";
import { SettingsDialog } from "./SettingsPopup.tsx";

export function ArtifactArchiveDialog({
  artifactId,
  onCancel,
  onDone,
}: {
  artifactId: string;
  onCancel: () => void;
  onDone: (notice: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState("");
  const [operationKey] = useState(() => crypto.randomUUID());
  const request = useRef<{ message: string; operationKey: string } | null>(null);
  const qc = useQueryClient();
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const archive = useMutation({
    mutationFn: () => {
      // A lost response retries exactly the original transition and message.
      request.current ??= { message, operationKey };
      return artifactApi.lifecycle(artifactId, { event: "archived", ...request.current });
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["artifact", artifactId] });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
      onDone(
        result.notification.state === "failed"
          ? "Archived. The message was saved, but delivery to the listener failed."
          : "Archived.",
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
          Archive artifact
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          Optionally leave a message for the current listener. Versions and conversations stay
          available.
        </p>
        <textarea
          aria-label="Archive message (optional)"
          placeholder="Message for the agent (optional)…"
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
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={archive.isPending}>
            {archive.isPending ? "Archiving…" : archive.error ? "Retry archive" : "Archive"}
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
  onToggleCommenting,
  feedbackVisible,
  onToggleFeedback,
}: {
  detail: ArtifactDetail;
  version?: ArtifactVersion | null;
  selectedVersion?: number | null;
  onSelectVersion?: (seq: number | null) => void;
  detailsRequest?: number;
  onJumpRef?: (reference: MessageRef) => void;
  commenting?: boolean;
  onToggleCommenting?: () => void;
  feedbackVisible?: boolean;
  onToggleFeedback?: () => void;
}) {
  detail = useOptimisticArtifact(detail);
  const qc = useQueryClient();
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
  const [notice, setNotice] = useState("");
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
      setNotice("Restored. An agent can register a new listener.");
    },
  });
  const error = edit.error ?? restore.error;
  return (
    <AppHeader showSettings={false}>
      <ArtifactKindIcon kind={detail.kind} />
      <span
        className="min-w-0 flex-1 truncate text-sm font-semibold"
        title={detail.title || detail.id}
      >
        {detail.title || detail.id}
      </span>
      {onSelectVersion && (
        <ArtifactOpenLatest
          latest={detail.versions.at(-1)?.seq}
          selected={selectedVersion}
          onOpen={onSelectVersion}
          className="md:py-[calc(.25rem-1px)] max-md:hidden"
        />
      )}
      {onSelectVersion && (
        <div className="flex min-w-0 max-w-[35%] self-stretch border-x border-neutral-200 max-md:hidden dark:border-neutral-800">
          <ArtifactVersionSelect
            versions={detail.versions}
            selected={selectedVersion}
            onChange={onSelectVersion}
          />
        </div>
      )}
      {detail.state === "archived" && <Pill>Archived</Pill>}
      {onToggleCommenting && (
        <Button
          variant={commenting ? "primary-outline" : "nav"}
          className="shrink-0 px-1.5 py-[calc(.375rem-1px)] max-md:size-9"
          aria-label={commenting ? "Exit comment mode" : "Comment mode"}
          title={commenting ? "Exit comment mode" : "Comment mode"}
          aria-pressed={commenting}
          onClick={onToggleCommenting}
        >
          <StrokeIcon className="size-4">
            <path d="M4 8V4h4M12 4h4v4M4 12v4h4" />
            <path d="m10 10 4 11 2-5 5-2-11-4Z" />
          </StrokeIcon>
        </Button>
      )}
      {onToggleFeedback && (
        <ArtifactFeedbackToggle
          artifactId={detail.id}
          feedback={detail.feedback}
          visible={!!feedbackVisible}
          onToggle={onToggleFeedback}
        />
      )}
      <Button
        ref={detailsTrigger}
        variant="nav"
        className="shrink-0 px-[calc(.375rem-1px)] py-[calc(.375rem-2px)] max-md:size-9"
        aria-label="Artifact details and actions"
        title="Artifact details and actions"
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(!detailsOpen)}
      >
        <StrokeIcon className="size-4">
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </StrokeIcon>
      </Button>
      {detailsOpen && (
        <button
          type="button"
          aria-label="Close artifact details"
          onClick={() => setDetailsOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      <div
        ref={details}
        role="dialog"
        hidden={!detailsOpen}
        aria-label="Artifact details"
        className="absolute right-2 top-full z-50 mt-1 max-h-[calc(100dvh-4rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg [overflow-wrap:anywhere] border border-neutral-300 bg-white p-3 text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      >
        <section className="mb-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          {title === null ? (
            <Button
              ref={titleButton}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                edit.reset();
                setTitle(detail.title ?? "");
              }}
            >
              Edit title
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
                edit.mutate();
              }}
            >
              <input
                ref={titleInput}
                aria-label="Artifact title"
                className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2 text-sm max-md:text-base dark:border-neutral-700"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={edit.isPending}
              />
              <div className="flex justify-end gap-1">
                <Button type="submit" disabled={edit.isPending}>
                  Save
                </Button>
                <Button type="button" disabled={edit.isPending} onClick={() => setTitle(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </section>
        {detailsOpen && onSelectVersion && (
          <section className="mb-3 border-b border-neutral-200 pb-3 md:hidden dark:border-neutral-800">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium text-neutral-500">Version</h2>
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
        <Button
          variant="ghost"
          className="mb-2 w-full justify-between"
          aria-haspopup="dialog"
          onClick={() => {
            setDetailsOpen(false);
            setSettingsOpen(true);
          }}
        >
          Settings
          <StrokeIcon className="size-4">
            <path d="m9 6 6 6-6 6" />
          </StrokeIcon>
        </Button>
        <ArtifactPreviewSecurity />
        {version?.summary && (
          <section className="mb-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
            <h2 className="mb-2 text-xs font-medium text-neutral-500">
              Description · Version {version.seq}
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
          <summary className="cursor-pointer">Details</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <CopyMeta hint="Copy artifact id" value={detail.id}>
              {detail.id}
            </CopyMeta>
            {detail.createdBy.role === "agent" && (
              <CopyMeta hint="Copy publisher session" value={detail.createdBy.sessionId}>
                Publisher: {detail.createdBy.sessionId}
              </CopyMeta>
            )}
            {Object.entries(detail.meta).map(([key, value]) => (
              <CopyMeta key={key} hint={`Copy ${key}`} value={value}>
                {key}: {value}
              </CopyMeta>
            ))}
          </div>
        </details>
        {detail.events.length > 0 && (
          <details className="mt-2 text-xs text-neutral-500">
            <summary className="cursor-pointer">Lifecycle history · {detail.events.length}</summary>
            <ol className="mt-2 space-y-2">
              {detail.events.map((event) => (
                <li
                  key={event.id}
                  className="border-l-2 border-neutral-200 pl-2 dark:border-neutral-700"
                >
                  <div>
                    {event.event === "archived" ? "Archived" : "Restored"} ·{" "}
                    <time dateTime={event.createdAt}>
                      {new Date(event.createdAt).toLocaleString()}
                    </time>
                  </div>
                  {event.message && <MessageProse source={event.message} />}
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
              Archive artifact
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
              Restore artifact
            </Button>
          )}
        </div>
      </div>
      {(notice || error) && (
        <div
          role={error ? "alert" : "status"}
          className="absolute right-2 top-full z-30 mt-1 flex max-w-[calc(100vw-1rem)] items-center gap-2 rounded-lg border border-neutral-300 bg-white p-3 text-xs r3-popover dark:border-neutral-700 dark:bg-neutral-950"
        >
          <span className={error ? "text-red-600" : "text-neutral-500"}>
            {error?.message ?? notice}
          </span>
          <Button
            variant="ghost"
            aria-label="Dismiss notice"
            onClick={() => {
              setNotice("");
              edit.reset();
              restore.reset();
            }}
          >
            ×
          </Button>
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} trigger={detailsTrigger} />
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
    </AppHeader>
  );
}
