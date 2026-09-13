import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ArtifactDetail, ArtifactVersion } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { suspendKeys } from "../keys.ts";
import type { MessageRef } from "../markdown.ts";
import { Button, CommentPlusIcon, CopyMeta, Pill, StrokeIcon, useEscape } from "../ui.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { ArtifactPreviewSecurity } from "./ArtifactPreviewSecurity.tsx";
import { MessageProse } from "./Message.tsx";

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
  useEffect(() => {
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
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 shadow-xl backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
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
          className="mt-4 w-full rounded border border-neutral-300 bg-transparent p-2 text-sm max-md:text-base dark:border-neutral-700"
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
  detailsRequest,
  onJumpRef,
  commenting,
  onToggleCommenting,
}: {
  detail: ArtifactDetail;
  version?: ArtifactVersion | null;
  detailsRequest?: number;
  onJumpRef?: (reference: MessageRef) => void;
  commenting?: boolean;
  onToggleCommenting?: () => void;
}) {
  const qc = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (detailsRequest) setDetailsOpen(true);
  }, [detailsRequest]);
  useEffect(() => {
    if (detailsOpen) return suspendKeys();
  }, [detailsOpen]);
  useEscape(detailsOpen, () => setDetailsOpen(false));
  const [title, setTitle] = useState<string | null>(null);
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
    <AppHeader>
      {detail.kind !== "html" && (
        <span
          role="img"
          aria-label={detail.kind === "files" ? "Files artifact" : "Diff artifact"}
          title={detail.kind === "files" ? "Files artifact" : "Diff artifact"}
          className="shrink-0 text-neutral-500"
        >
          <StrokeIcon className="size-4">
            {detail.kind === "files" ? (
              <>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6M8 12h8M8 16h8" />
              </>
            ) : (
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h6M11 9v6M8 18h6" />
            )}
          </StrokeIcon>
        </span>
      )}
      {title === null ? (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
          title={detail.title || detail.id}
          aria-label={`Edit title: ${detail.title || detail.id}`}
          onClick={() => setTitle(detail.title ?? "")}
        >
          {detail.title || detail.id}
        </button>
      ) : (
        <form
          className="flex min-w-0 flex-1 gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            edit.mutate();
          }}
        >
          <input
            aria-label="Artifact title"
            className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2 text-sm max-md:text-base dark:border-neutral-700"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={edit.isPending}
          />
          <Button type="submit" disabled={edit.isPending}>
            Save
          </Button>
          <Button type="button" onClick={() => setTitle(null)}>
            Cancel
          </Button>
        </form>
      )}
      <ArtifactPreviewSecurity />
      {title === null && (
        <>
          {detail.state === "archived" && <Pill>Archived</Pill>}
          {onToggleCommenting && (
            <Button
              variant={commenting ? "primary" : "ghost"}
              className="shrink-0 p-1.5 max-md:size-9"
              aria-label={commenting ? "Exit comment mode" : "Comment mode"}
              title={commenting ? "Exit comment mode" : "Comment mode"}
              aria-pressed={commenting}
              onClick={onToggleCommenting}
            >
              <CommentPlusIcon className="size-4" />
            </Button>
          )}
          {detail.state === "active" ? (
            <Button onClick={() => setArchiveOpen(true)}>Archive</Button>
          ) : (
            <Button onClick={() => restore.mutate()} disabled={restore.isPending}>
              Restore
            </Button>
          )}
          <Button
            variant="ghost"
            className="shrink-0 p-1.5 max-md:size-9"
            aria-label="Artifact details"
            title="Artifact details"
            aria-haspopup="dialog"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            <StrokeIcon className="size-4">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v6M12 7h.01" />
            </StrokeIcon>
          </Button>
        </>
      )}
      {detailsOpen && (
        <>
          <button
            type="button"
            aria-label="Close artifact details"
            onClick={() => setDetailsOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="dialog"
            aria-label="Artifact details"
            className="absolute right-2 top-full z-50 mt-1 max-h-[calc(100dvh-4rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg [overflow-wrap:anywhere] border border-neutral-300 bg-white p-3 text-neutral-900 shadow-xl dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          >
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
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <CopyMeta hint="Copy artifact id" value={detail.id}>
                {detail.id}
              </CopyMeta>
              {Object.entries(detail.meta).map(([key, value]) => (
                <CopyMeta key={key} hint={`Copy ${key}`} value={value}>
                  {key}: {value}
                </CopyMeta>
              ))}
            </div>
            {detail.events.length > 0 && (
              <details className="mt-2 text-xs text-neutral-500">
                <summary className="cursor-pointer">
                  Lifecycle history · {detail.events.length}
                </summary>
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
          </div>
        </>
      )}
      {(notice || error) && (
        <div
          role={error ? "alert" : "status"}
          className="absolute right-2 top-full z-30 mt-1 flex max-w-[calc(100vw-1rem)] items-center gap-2 rounded-lg border border-neutral-300 bg-white p-3 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-950"
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
