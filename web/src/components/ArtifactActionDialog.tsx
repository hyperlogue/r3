import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ArtifactApiError } from "../../../shared/artifact-client.ts";
import type { Artifact } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
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
  api = artifactApi,
): Promise<ArtifactActionResult[]> {
  const results: ArtifactActionResult[] = [];
  for (const item of items) {
    try {
      if (action === "delete") await api.delete(item.id);
      else {
        const current = await api.detail(item.id);
        if (current.state === "archived" && !keys.has(item.id)) {
          results.push({ id: item.id, state: "skipped" });
          continue;
        }
        if (!keys.has(item.id)) keys.set(item.id, crypto.randomUUID());
        const result = await api.lifecycle(item.id, {
          event: "archived",
          operationKey: keys.get(item.id)!,
          message,
        });
        results.push({
          id: item.id,
          state: "done",
          ...(result.notification.state === "failed"
            ? { warning: "Archived, but agent notification failed" }
            : {}),
        });
        continue;
      }
      results.push({ id: item.id, state: "done" });
    } catch (error) {
      if (action === "delete" && error instanceof ArtifactApiError && error.status === 404)
        results.push({ id: item.id, state: "skipped" });
      else
        results.push({
          id: item.id,
          state: "failed",
          warning: error instanceof Error ? error.message : "Action failed",
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
  const dialog = useRef<HTMLDialogElement>(null);
  const keys = useRef(new Map<string, string>());
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();
  const label = action === "delete" ? "Delete" : "Archive";
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={`${label} ${items.length === 1 ? "artifact" : "artifacts"}`}
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
          const results = await actOnArtifacts(items, action, message, keys.current);
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
        <h2 className="font-semibold">
          {label} {items.length} {items.length === 1 ? "artifact" : "artifacts"}
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          {action === "delete"
            ? "Permanently remove every version and conversation. This cannot be undone and does not wait for the archive TTL."
            : "Keep versions and conversations. Archived artifacts become eligible for cleanup after the configured TTL. Already archived artifacts are skipped."}
        </p>
        <ul className="my-4 max-h-48 overflow-y-auto border-y border-neutral-200 py-2 text-sm dark:border-neutral-700">
          {items.map((item) => (
            <li key={item.id} className="py-1">
              <span className="break-words">{item.title ?? item.id}</span>
              <span className="ml-2 text-xs text-neutral-500">{item.state}</span>
            </li>
          ))}
        </ul>
        {action === "archive" && (
          <textarea
            aria-label="Shared archive message (optional)"
            placeholder="Message for each listening agent (optional)…"
            rows={3}
            value={message}
            disabled={pending}
            onChange={(event) => setMessage(event.target.value)}
            className="w-full border border-neutral-300 bg-transparent p-2 text-sm max-md:text-base dark:border-neutral-700"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={action === "delete" ? "danger" : "primary"}
            disabled={pending}
          >
            {pending ? "Working…" : `${label} ${items.length === 1 ? "artifact" : "artifacts"}`}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
