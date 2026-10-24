import type {
  ArtifactActor,
  ArtifactDocumentTarget,
  ArtifactTarget,
  ArtifactThread,
  RenderedLocator,
} from "./artifacts.ts";
import type { AttachmentInput } from "./attachments.ts";

// Moving a thread never edits its original quotation. Source/diff matching
// evidence is prepared from retained destination bytes by the backend.
export type ArtifactAnchorDestination =
  | {
      kind: "source";
      versionSeq: number;
      path: string;
      locator: { start: number; end: number } | null;
    }
  | {
      kind: "diff";
      versionSeq: number;
      path: string;
      locator: { start: number; end: number; side: "old" | "new" } | null;
    }
  | {
      kind: "rendered";
      versionSeq: number;
      path: string;
      locator: Omit<RenderedLocator, "quote" | "prefix" | "suffix"> | null;
    }
  | Extract<ArtifactDocumentTarget, { kind: "media" }>;

export interface ArtifactThreadAnchor {
  target: ArtifactDocumentTarget;
  revision: number;
  actor: ArtifactActor;
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactReanchorGuard {
  expectedSeq: number;
  expectedAnchorRevision: number;
}
export interface ArtifactReanchorBody {
  actor: ArtifactActor;
  expectedSeq: number;
  operationKey: string;
  items: {
    threadId: string;
    expectedAnchorRevision: number;
    target: ArtifactAnchorDestination;
    mediaSnapshot?: AttachmentInput;
  }[];
}
export interface ArtifactReanchorResult {
  operationKey: string;
  results: { threadId: string; revision: number; changed: boolean }[];
}
export interface ArtifactAnchorResolution {
  threadId: string;
  anchorRevision: number;
  versionSeq: number;
  state: "anchored" | "ambiguous" | "unplaced" | "runtime-required";
  target: ArtifactDocumentTarget | null;
}
export function currentThreadTarget(thread: ArtifactThread): ArtifactTarget {
  return thread.anchor?.target ?? thread.target;
}
