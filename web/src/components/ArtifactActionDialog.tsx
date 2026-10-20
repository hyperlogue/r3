import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ArtifactApiError } from "../../../shared/artifact-client.ts";
import { ARTIFACT_BULK_ARCHIVE_LIMIT, type Artifact } from "../../../shared/artifacts.ts";
import { type ArtifactPageClient, useArtifactClient } from "../artifact-ui-context.tsx";
import { plural, t, useLocale } from "../i18n.ts";
import { Button } from "../ui.tsx";
export type ActionArtifact = Pick<Artifact, "id" | "title" | "state">;
export interface ArtifactActionResult {
  id: string;
  state: "done" | "skipped" | "failed";
  warning?: string;
}
export async function actOnArtifacts(
  items: ActionArtifact[],
  action: "archive" | "delete",
  message: string,
  keys: Map<string, string>,
  api: Pick<ArtifactPageClient, "delete" | "bulkArchive">,
): Promise<ArtifactActionResult[]> {
  const results: ArtifactActionResult[] = [];
  if (action === "archive") {
    for (let start = 0; start < items.length; start += ARTIFACT_BULK_ARCHIVE_LIMIT) {
      const batch = items.slice(start, start + ARTIFACT_BULK_ARCHIVE_LIMIT);
      for (const item of batch) if (!keys.has(item.id)) keys.set(item.id, crypto.randomUUID());
      try {
        const response = await api.bulkArchive({
          items: batch.map(({ id }) => ({ id, operationKey: keys.get(id)! })),
          comment: { body: message },
        });
        for (const result of response.results) {
          if (result.state === "failed")
            results.push({ id: result.id, state: "failed", warning: result.error });
          else if (result.state === "skipped") results.push({ id: result.id, state: "skipped" });
          else
            results.push({
              id: result.id,
              state: "done",
              ...(result.notification.state === "failed"
                ? { warning: t("Archived, but agent notification failed") }
                : {}),
            });
        }
      } catch (error) {
        for (const item of batch)
          results.push({
            id: item.id,
            state: "failed",
            warning: error instanceof Error ? error.message : t("Action failed"),
          });
      }
    }
    return results;
  }
  for (const item of items) {
    try {
      await api.delete(item.id);
      results.push({ id: item.id, state: "done" });
    } catch (error) {
      if (error instanceof ArtifactApiError && error.status === 404)
        results.push({ id: item.id, state: "skipped" });
      else
        results.push({
          id: item.id,
          state: "failed",
          warning: error instanceof Error ? error.message : t("Action failed"),
        });
    }
  }
  return results;
}
export function ArtifactActionDialog({
  items,
  action,
  onClose,
  onDone,
}: {
  items: ActionArtifact[];
  action: "archive" | "delete";
  onClose: () => void;
  onDone: (results: ArtifactActionResult[]) => void;
}) {
  useLocale();
  const api = useArtifactClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const keys = useRef(new Map<string, string>());
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();
  const heading =
    action === "delete"
      ? plural("Delete {count} artifact", "Delete {count} artifacts", items.length)
      : plural("Archive {count} artifact", "Archive {count} artifacts", items.length);
  const actionLabel =
    action === "delete"
      ? plural("Delete artifact", "Delete artifacts", items.length)
      : plural("Archive artifact", "Archive artifacts", items.length);
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={actionLabel}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          const results = await actOnArtifacts(items, action, message, keys.current, api);
          for (const key of [
            "artifacts",
            "artifact",
            "artifact-search",
            "artifact-usage",
            "artifact-gc",
          ])
            void qc.invalidateQueries({ queryKey: [key] });
          setPending(false);
          onDone(results);
        }}
      >
        <h2 className="font-semibold">{heading}</h2>
        <p className="mt-2 text-sm text-neutral-500">
          {action === "delete"
            ? t(
                "Permanently remove every version and conversation. This cannot be undone and does not wait for the archive TTL.",
              )
            : t(
                "Keep versions and conversations. Archived artifacts become eligible for cleanup after the configured TTL. Already archived artifacts are skipped.",
              )}
        </p>
        <ul className="my-4 max-h-48 overflow-y-auto border-y border-neutral-200 py-2 text-sm dark:border-neutral-700">
          {items.map((item) => (
            <li key={item.id} className="py-1">
              <span className="break-words">{item.title ?? item.id}</span>
              <span className="ml-2 text-xs text-neutral-500">
                {t(item.state === "active" ? "Active" : "Archived")}
              </span>
            </li>
          ))}
        </ul>
        {action === "archive" && (
          <textarea
            aria-label={t("Shared archive message (optional)")}
            placeholder={t("Message for each listening agent (optional)…")}
            rows={3}
            value={message}
            disabled={pending}
            onChange={(event) => setMessage(event.target.value)}
            className="w-full border border-neutral-300 bg-transparent p-2 text-sm max-md:text-base dark:border-neutral-700"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" disabled={pending} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            variant={action === "delete" ? "danger" : "primary"}
            disabled={pending}
          >
            {pending ? t("Working…") : actionLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
