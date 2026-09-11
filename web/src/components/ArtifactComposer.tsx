import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { artifactTargetLabel } from "../../../shared/artifact-prompt.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts, useArtifactDraft } from "../artifact-drafts.ts";
import { useAutoGrow } from "../autogrow.ts";
import { Button } from "../ui.tsx";

// Draft subscription and mutation live with the textarea. Typing does not
// subscribe the conversation list or the content pane to every character.
export function ArtifactComposer({
  artifactId,
  replyTo,
  onDone,
}: {
  artifactId: string;
  replyTo?: string;
  onDone?: () => void;
}) {
  const draft = useArtifactDraft(artifactId, replyTo);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const ref = useAutoGrow(textarea, draft?.body ?? "", 3, 12);
  const qc = useQueryClient();
  const post = useMutation({
    mutationFn: async () => {
      if (!draft?.body.trim()) return;
      if (replyTo) await artifactApi.reply(replyTo, { body: draft.body, context: draft.context });
      else await artifactApi.addFeedback(artifactId, draft.body, draft.target);
    },
    onSuccess: () => {
      artifactDrafts.clear(artifactId, replyTo);
      void qc.invalidateQueries({ queryKey: ["artifact", artifactId] });
      onDone?.();
    },
  });
  const context = draft?.context;
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft?.body.trim() && !post.isPending) post.mutate();
      }}
    >
      <div className="flex items-start justify-between gap-2 text-xs text-neutral-500">
        <span>
          {replyTo
            ? context?.versionSeq
              ? `Reply about version ${context.versionSeq}${context.representation ? ` · ${context.representation}` : ""}`
              : "Reply without a published context"
            : artifactTargetLabel(draft?.target ?? { kind: "artifact" })}
        </span>
        {!replyTo && draft?.target.kind !== "artifact" && draft?.target && (
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => artifactDrafts.update(artifactId, { target: { kind: "artifact" } })}
          >
            Clear target
          </button>
        )}
      </div>
      {draft?.imported && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Imported draft. Its original published context is unknown; the saved text and anchor
          evidence are preserved.
        </p>
      )}
      {draft &&
        "locator" in draft.target &&
        draft.target.locator &&
        "quote" in draft.target.locator &&
        draft.target.locator.quote && (
          <blockquote className="max-h-24 overflow-auto border-l-2 border-neutral-300 pl-2 text-xs text-neutral-500 whitespace-pre-wrap">
            {draft.target.locator.quote}
          </blockquote>
        )}
      <textarea
        ref={ref}
        aria-label={replyTo ? "Reply" : "Feedback"}
        placeholder={replyTo ? "Write a reply…" : "Write feedback…"}
        disabled={post.isPending}
        value={draft?.body ?? ""}
        onChange={(event) =>
          artifactDrafts.update(artifactId, { body: event.target.value }, replyTo)
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        className="w-full resize-none rounded border border-neutral-300 bg-transparent p-2 text-sm outline-none focus:border-primary-500 max-md:text-base dark:border-neutral-700"
      />
      {post.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {post.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {draft?.body && (
          <Button
            type="button"
            disabled={post.isPending}
            onClick={() => {
              artifactDrafts.clear(artifactId, replyTo);
              onDone?.();
            }}
          >
            Discard
          </Button>
        )}
        <Button type="submit" disabled={!draft?.body.trim() || post.isPending}>
          {post.isPending ? "Saving…" : replyTo ? "Reply" : "Add feedback"}
        </Button>
      </div>
    </form>
  );
}
