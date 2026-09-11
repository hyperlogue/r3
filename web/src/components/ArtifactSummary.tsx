import type { ArtifactTarget } from "../../../shared/artifacts.ts";
import { normalizeRenderedText } from "../../../shared/rendered-text.ts";
import type { MessageRef } from "../markdown.ts";
import { Button } from "../ui.tsx";
import { MessageProse } from "./Message.tsx";

export function ArtifactSummary({
  source,
  versionSeq,
  onTarget,
  onJumpRef,
}: {
  source: string | null;
  versionSeq?: number;
  onTarget: (target: ArtifactTarget) => void;
  onJumpRef: (reference: MessageRef) => void;
}) {
  if (!source) return null;
  const target: ArtifactTarget =
    versionSeq === undefined
      ? { kind: "artifact_summary", locator: null }
      : { kind: "version_summary", versionSeq, locator: null };
  return (
    <section
      data-artifact-summary={versionSeq ?? "artifact"}
      className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
        <span>{versionSeq === undefined ? "Overview" : `Version ${versionSeq}`}</span>
        <Button variant="ghost" onClick={() => onTarget(target)}>
          Comment
        </Button>
      </div>
      <div
        onMouseUp={(event) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed || !selection.rangeCount) return;
          const range = selection.getRangeAt(0);
          if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
          const quote = normalizeRenderedText(selection.toString()).slice(0, 16_384);
          if (quote) onTarget({ ...target, locator: { quote } });
        }}
      >
        <MessageProse source={source} onJumpRef={onJumpRef} />
      </div>
    </section>
  );
}
