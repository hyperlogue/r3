import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ArtifactDetail } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { Button, CopyMeta, Pill } from "../ui.tsx";
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
  onDeleted,
}: {
  detail: ArtifactDetail;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  const remove = useMutation({
    mutationFn: () => artifactApi.delete(detail.id),
    onSuccess: () => {
      refresh();
      onDeleted();
    },
  });
  const error = edit.error ?? restore.error ?? remove.error;
  return (
    <header className="shrink-0 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-2">
        <Pill>{detail.kind}</Pill>
        <Pill>{detail.state === "archived" ? "Archived" : "Active"}</Pill>
        {title === null ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-semibold max-md:order-first max-md:basis-full"
            title="Edit title"
            onClick={() => setTitle(detail.title ?? "")}
          >
            {detail.title || detail.id}
          </button>
        ) : (
          <form
            className="flex min-w-0 flex-1 gap-1 max-md:order-first max-md:basis-full"
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
        {detail.state === "active" ? (
          <Button onClick={() => setArchiveOpen(true)}>Archive</Button>
        ) : (
          <Button onClick={() => restore.mutate()} disabled={restore.isPending}>
            Restore
          </Button>
        )}
        <Button variant="ghost" onClick={() => setDeleting(!deleting)}>
          Delete
        </Button>
      </div>
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
      {notice && (
        <p role="status" className="mt-2 text-xs text-neutral-500">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error.message}
        </p>
      )}
      {deleting && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>Delete this artifact, every version, and every conversation?</span>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete permanently
          </Button>
          <Button onClick={() => setDeleting(false)}>Keep artifact</Button>
        </div>
      )}
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
    </header>
  );
}
