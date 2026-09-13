import type { ArtifactKind } from "../../../shared/artifacts.ts";
import { StrokeIcon } from "../ui.tsx";

export function ArtifactKindIcon({ kind }: { kind: ArtifactKind }) {
  const label = { html: "HTML artifact", files: "Files artifact", diff: "Diff artifact" }[kind];
  return (
    <span role="img" aria-label={label} title={label} className="shrink-0 text-neutral-500">
      <StrokeIcon className="size-4">
        {kind === "html" ? (
          <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 8h18M7 5.5h.01M10 5.5h.01" />
          </>
        ) : kind === "files" ? (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M8 12h8M8 16h8" />
          </>
        ) : (
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h6M11 9v6M8 18h6" />
        )}
      </StrokeIcon>
    </span>
  );
}
