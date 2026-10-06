import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { ArtifactGcResult } from "../../../shared/artifact-usage.ts";
import { artifactApi } from "../artifact-api.ts";
import { formatBytes } from "../format-bytes.ts";
import { Button } from "../ui.tsx";

export function ArtifactGcDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ArtifactGcResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["artifact-gc"],
    queryFn: () => artifactApi.gc({ dryRun: true }),
    staleTime: 0,
  });
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const data = result ?? preview.data;
  return (
    <dialog
      ref={dialog}
      aria-label="Clean up archived artifacts"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 className="font-semibold">Clean up archived artifacts</h2>
      {preview.isPending && (
        <p role="status" className="mt-3 text-sm">
          Checking eligible artifacts…
        </p>
      )}
      {(preview.error || error) && (
        <p role="alert" className="mt-3 text-sm text-danger-600">
          {error ?? preview.error?.message}{" "}
          <Button
            onClick={() => {
              setError(null);
              void preview.refetch();
            }}
          >
            Refresh preview
          </Button>
        </p>
      )}
      {data && (
        <>
          <p className="mt-3 text-sm text-neutral-500">
            {data.candidates.length} {data.candidates.length === 1 ? "artifact" : "artifacts"}{" "}
            archived at least {data.ttlDays} days ago. {formatBytes(data.reclaimableBytes)} of
            reclaimable content. Shared bytes still in use are retained.
          </p>
          <p className="mt-2 text-sm">
            Deletion permanently removes all versions and conversations.
          </p>
          <ul className="my-4 max-h-56 overflow-y-auto border-y border-neutral-200 py-2 text-sm dark:border-neutral-700">
            {data.candidates.map((item) => (
              <li key={item.id} className="py-1">
                <span className="break-words">{item.title ?? item.id}</span>
                <span className="block text-xs text-neutral-500">
                  Archived {new Date(item.archivedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {result && (
        <div role="status" className="text-sm">
          Deleted {result.deletedIds.length} · Skipped {result.skippedIds.length} · Failed{" "}
          {result.failures.length}
          {result.skippedIds.length > 0 && (
            <p>Skipped artifacts changed or were removed after the preview.</p>
          )}
          {result.failures.map((failure) => (
            <p key={failure.id}>
              {failure.id}: {failure.error}
            </p>
          ))}
          {result.cleanupError && <p role="alert">{result.cleanupError}</p>}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button disabled={pending} onClick={onClose}>
          {result ? "Done" : "Cancel"}
        </Button>
        {!result && (
          <Button
            variant="danger"
            disabled={
              pending ||
              preview.isFetching ||
              !!preview.error ||
              !!error ||
              !data?.candidates.length
            }
            onClick={async () => {
              if (!data || pending) return;
              setPending(true);
              setError(null);
              try {
                setResult(
                  await artifactApi.gc({
                    ttlDays: data.ttlDays,
                    candidates: data.candidates.map(({ id, archivedAt }) => ({ id, archivedAt })),
                  }),
                );
                for (const key of [
                  "artifacts",
                  "artifact",
                  "artifact-search",
                  "artifact-usage",
                  "artifact-gc",
                ])
                  void qc.invalidateQueries({ queryKey: [key] });
              } catch (err) {
                setError(err instanceof Error ? err.message : "Cleanup failed");
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Deleting…" : "Delete eligible artifacts"}
          </Button>
        )}
      </div>
    </dialog>
  );
}
