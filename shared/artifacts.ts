export type {
  ArtifactGcRequest,
  ArtifactGcResult,
  ArtifactUsage,
  UsageWindow,
} from "./artifact-usage.ts";

import type { ArtifactAttachment, AttachmentInput } from "./attachments.ts";
import type { WorkerSubscription } from "./worker-protocol.ts";

export type {
  ArtifactSearchMatch,
  ArtifactSearchOptions,
  ArtifactSearchResponse,
} from "./artifact-search.ts";
// Artifact HTTP contract. Content and message targets always name a publication;
// publisher-local paths and live working trees never participate in reads.
export const ARTIFACT_KINDS = ["files", "html", "diff"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactState = "active" | "archived";
export type Representation = "source" | "rendered" | "diff" | "media";
export type ArtifactActor =
  | {
      role: "human";
      sessionId: null;
    }
  | {
      role: "agent";
      sessionId: string;
    };
export interface AgentSession {
  id: string;
  harness: string | null;
  label: string | null;
  createdAt: string;
}
export interface ArtifactProject {
  id: string;
  name: string | null;
  remoteUrl: string | null;
  createdAt: string;
}
export interface EditArtifactProjectBody {
  name?: string | null;
  remoteUrl?: string | null;
  // Compare-and-set for backfill; null means the stored remote must be absent.
  expectedRemoteUrl?: string | null;
}
export interface ArtifactStorageUsage {
  attachmentBytes?: number;
  // Distinct original/retained blobs across published versions plus each patch's
  // UTF-8 bytes. Excludes database/filesystem overhead and unpublished content.
  // Shared blobs count toward each referencing artifact, not reclaimable space.
  totalBytes: number;
  // Full content footprint of the latest publication, not its incremental cost.
  // Zero before the first publication. Independent of the reader's selection.
  latestVersionBytes: number;
}
export interface Artifact {
  // A list projection of the latest committed publication; never nextSeq - 1.
  latestVersion?: Pick<ArtifactVersion, "seq" | "label" | "summary" | "publishedAt"> | null;
  id: string;
  kind: ArtifactKind;
  state: ArtifactState;
  projectId: string | null;
  title: string | null;
  meta: Record<string, string>;
  createdBy: ArtifactActor;
  nextSeq: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  watching: boolean;
  working: boolean;
  // Open threads whose latest message is from an agent; independent of reading.
  unhandledCount: number;
  storage: ArtifactStorageUsage;
  legacy: Record<string, unknown> | null;
}
interface VersionMetadata {
  artifactId: string;
  seq: number;
  publicationKey: string;
  contentHash: string;
  label: string | null;
  summary: string | null;
  publishedBy: ArtifactActor;
  provenance: Record<string, unknown>;
  createdAt: string;
  publishedAt: string;
}
export type ArtifactVersion = VersionMetadata &
  (
    | {
        kind: "files";
        entrypoint: null;
        fileCount: number;
      }
    // index.md survives in historical versions; new HTML publications require index.html.
    | {
        kind: "html";
        entrypoint: "index.html" | "index.md";
        fileCount: number;
      }
    | {
        kind: "diff";
        entrypoint: null;
        fileCount: null;
      }
  );
export type ArtifactPublicationResponse = ArtifactVersion & {
  url: string;
  listenerRegistered: boolean;
  listener?: WorkerSubscription;
};
export interface ArtifactFile {
  path: string;
  mediaType: string;
  hash: string;
  byteLength: number;
  renderedHash: string | null;
  rendererRevision: string | null;
}
export interface TextQuote {
  quote: string;
  prefix?: string;
  suffix?: string;
}
export interface SourceLocator {
  start: number;
  end: number;
  // Exact excerpt from within the captured range; it need not cover every line.
  quote: string;
}
// Complete captured lines for a discussion target, fetched only on demand.
export interface ArtifactSourceRange {
  artifactId: string;
  versionSeq: number;
  path: string;
  side: "old" | "new" | null;
  start: number;
  end: number;
  text: string;
}
// Full-height Markdown frames can exceed an ordinary browser window. Keep
// height reports and native viewport evidence within the same layout bound.
export const MAX_RENDERED_HEIGHT = 16000000;
export interface RenderedLocator {
  selector: string;
  // Optional human-readable location name; never used to match the element.
  label?: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  route?: string;
  viewport?: {
    width: number;
    height: number;
  };
}
export interface DiffLocator extends SourceLocator {
  side: "old" | "new";
}
export interface MediaBox {
  // Fractions of the intrinsic frame, excluding letterboxing and player controls.
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MediaLocator {
  // One navigation instant in seconds, without rounding; null for still images.
  time: number | null;
  box: MediaBox;
  // Present on saved targets. The snapshot is authoritative, seeking is approximate.
  frame?: ArtifactAttachment;
}
export interface ArtifactMediaTarget {
  kind: "media";
  versionSeq: number;
  path: string;
  locator: MediaLocator;
}
export type ArtifactDocumentTarget =
  | ArtifactMediaTarget
  | {
      kind: "source";
      versionSeq: number;
      path: string;
      locator: SourceLocator | null;
    }
  | {
      kind: "rendered";
      versionSeq: number;
      path: string;
      locator: RenderedLocator | null;
    }
  | {
      kind: "diff";
      versionSeq: number;
      path: string;
      locator: DiffLocator | null;
    };
export type ArtifactVersionTarget =
  | ArtifactDocumentTarget
  // Read-only historical target from before description anchoring was retired.
  | {
      kind: "version_summary";
      versionSeq: number;
      locator: TextQuote | null;
    };
export type ArtifactTarget =
  | {
      kind: "artifact";
    }
  // Read-only historical target from before artifact overviews were retired.
  | {
      kind: "artifact_summary";
      locator: TextQuote | null;
    }
  | ArtifactVersionTarget;
export type ArtifactReferenceContext =
  | {
      versionSeq: null;
      representation: null;
    }
  | {
      versionSeq: number;
      representation: Representation | null;
    };
// References inherit the discussion's original evidence unless the comment
// identifies a different published location. Existing saved contexts stay pinned.
export function artifactReferenceContext(
  target: ArtifactTarget | null | undefined,
  original?: ArtifactTarget,
): ArtifactReferenceContext {
  const location = target ?? original;
  if (!location || !("versionSeq" in location)) return { versionSeq: null, representation: null };
  return {
    versionSeq: location.versionSeq,
    representation: location.kind === "version_summary" ? null : location.kind,
  };
}
export interface ArtifactClaim {
  discussionId: string;
  sessionId: string;
  claimedAt: string;
  renewedAt: string;
  expiresAt: string;
}
export interface ArtifactComment {
  attachments?: ArtifactAttachment[];
  id: string;
  discussionId: string;
  artifactId: string;
  author: ArtifactActor;
  body: string;
  context: ArtifactReferenceContext;
  target: ArtifactVersionTarget | null;
  legacy: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
}
export interface ArtifactDiscussion {
  id: string;
  artifactId: string;
  status: "open" | "resolved";
  target: ArtifactTarget;
  createdAt: string;
  updatedAt: string;
  statusUnsent: boolean;
  // Ordered messages, beginning with the opening Comment. Never empty.
  comments: ArtifactComment[];
  claim: ArtifactClaim | null;
}
export interface ArtifactPlacement {
  discussionId: string;
  artifactId: string;
  target: ArtifactDocumentTarget;
  state: "anchored" | "unplaced" | "ambiguous";
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactLifecycleEvent {
  id: string;
  seq: number;
  artifactId: string;
  event: "archived" | "restored";
  operationKey: string;
  actor: ArtifactActor;
  message: string | null;
  createdAt: string;
}
export interface ArtifactDetail extends Artifact {
  versions: ArtifactVersion[];
  discussions: ArtifactDiscussion[];
  placements: ArtifactPlacement[];
  events: ArtifactLifecycleEvent[];
  // Current labels only for sessions referenced by this artifact. Older saved
  // client snapshots may omit these; absent/unnamed entries display their ID.
  agentLabels?: Record<string, string | null>;
}
export function artifactAgentIds(detail: ArtifactDetail): string[] {
  return [
    ...new Set(
      [
        detail.createdBy.sessionId,
        ...detail.versions.map((version) => version.publishedBy.sessionId),
        ...detail.events.map((event) => event.actor.sessionId),
        ...detail.discussions.flatMap((discussions) => [
          discussions.comments[0]!.author.sessionId,
          discussions.claim?.sessionId,
          ...discussions.comments.slice(1).map((comment) => comment.author.sessionId),
        ]),
      ].filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
}
export interface CreateArtifactBody {
  kind: ArtifactKind;
  actor: ArtifactActor;
  projectId?: string | null;
  remoteUrl?: string | null;
  title?: string | null;
  meta?: Record<string, string>;
}
export interface EditArtifactBody {
  title?: string | null;
  meta?: Record<string, string>;
}
export interface ArtifactSource {
  artifactId: string;
  versionSeq: number;
  path: string;
  hash: string;
  byteLength: number;
  mediaType: string;
  kind: "text" | "binary" | "oversize";
  language: string | null;
  lines: {
    lineNo: number;
    text: string;
    html: string;
  }[];
}
// Binary-safe transfer. The version owns the complete path membership. Missing
// members are absent from this version; reads never fall back to its predecessor.
export interface PublicationFile {
  path: string;
  mediaType: string;
  base64: string;
}
export interface PublishArtifactBody {
  listen?: boolean;
  expectedSeq: number;
  publicationKey: string;
  actor: ArtifactActor;
  label?: string | null;
  summary?: string | null;
  provenance?: Record<string, unknown>;
  content:
    | {
        kind: "files";
        files: PublicationFile[];
      }
    | {
        kind: "html";
        files: PublicationFile[];
      }
    | {
        kind: "diff";
        patch: string;
      };
}
export interface CreateArtifactDiscussionBody {
  mediaSnapshot?: AttachmentInput;
  operationKey?: string;
  attachments?: AttachmentInput[];
  actor: ArtifactActor;
  body: string;
  target: ArtifactTarget;
}
export interface CreateArtifactCommentBody {
  mediaSnapshot?: AttachmentInput;
  operationKey?: string;
  attachments?: AttachmentInput[];
  actor: ArtifactActor;
  body: string;
  target?: ArtifactVersionTarget | null;
}
export interface EditArtifactDiscussionBody {
  attachments?: AttachmentInput[];
  actor: ArtifactActor;
  body?: string;
  status?: "open" | "resolved";
}
export interface EditArtifactCommentBody {
  attachments?: AttachmentInput[];
  actor: ArtifactActor;
  body: string;
}
export interface ArtifactPlacementBody {
  actor: ArtifactActor;
  target: ArtifactDocumentTarget;
  state: ArtifactPlacement["state"];
}
export function isUnhandledArtifactDiscussion(discussions: ArtifactDiscussion): boolean {
  return discussions.status === "open" && discussions.comments.at(-1)!.author.role === "agent";
}
export function hasUnsentArtifactDiscussion(discussions: ArtifactDiscussion): boolean {
  return (
    (discussions.comments[0]!.author.role === "human" &&
      discussions.comments[0]!.sentAt === null &&
      discussions.status === "open") ||
    discussions.statusUnsent ||
    discussions.comments
      .slice(1)
      .some((comment) => comment.author.role === "human" && comment.sentAt === null)
  );
}
export interface ArtifactLifecycleBody {
  actor: ArtifactActor;
  operationKey: string;
  event: "archived" | "restored";
  message?: string;
}
export type ArtifactStreamEvent =
  | {
      type: "artifact-updated";
      artifactId: string;
    }
  | {
      type: "artifact-deleted";
      artifactId: string;
    }
  | {
      type: "version-published";
      artifactId: string;
      seq: number;
    }
  | {
      type: "discussions-updated";
      artifactId: string;
      discussionId: string;
    }
  | {
      type: "presence-changed";
      artifactId: string;
    }
  | {
      type: "submitted";
      artifactId: string;
    }
  | {
      type: "lifecycle";
      artifactId: string;
      event: ArtifactLifecycleEvent;
    }
  | {
      type: "superseded";
      artifactId: string;
    };
export const ARTIFACT_WATCH_EXIT = { archived: 0, discussions: 10, timeout: 2, busy: 4 } as const;
export interface ArtifactWatcher {
  connectionState?: "connected" | "disconnected" | "failed";
  error?: string | null;
  listenerId?: string;
  id: string;
  kind: "watch" | "listen";
  actor: ArtifactActor;
  connectedAt: string;
  mode?: "fallback" | "explicit";
  label?: string | null;
}
export interface ArtifactNudge {
  id: string;
  artifactId: string;
  title: string | null;
  event: "submitted" | "archived";
  lifecycleEventId: string | null;
  message: string | null;
}
export type ArtifactDeliveryState = "sent" | "queued";
export type ArtifactNotification =
  | {
      state: "none" | ArtifactDeliveryState | "not_repeated";
    }
  | {
      state: "failed";
      error: string;
    };
export interface ArtifactLifecycleResponse {
  event: ArtifactLifecycleEvent;
  replayed: boolean;
  notification: ArtifactNotification;
}
export type ArtifactWatchResult =
  | {
      result: "archived";
      event: ArtifactLifecycleEvent | null;
    }
  | {
      result: "discussions" | "timeout" | "cancelled" | "superseded" | "deleted";
    };
export type ArtifactAgentStreamEvent =
  | {
      type: "ready";
      registration: ArtifactWatcher;
    }
  | {
      type: "nudge";
      nudge: ArtifactNudge;
    }
  | {
      type: "closed";
      reason: "archived" | "superseded" | "deleted" | "disconnected";
    }
  | {
      type: "heartbeat";
    };
export interface ArtifactNudgeAcknowledgment {
  actor: ArtifactActor;
  nudgeId: string;
  ok: boolean;
  // Older relay clients omit the state and imply sent on success.
  state?: ArtifactDeliveryState;
  error?: string;
}
export interface ArtifactDiscussionAcknowledgment {
  discussions?: string[];
  expectedFingerprint: string;
}
export interface ArtifactDiscussionRead {
  attachments?: ArtifactAttachment[];
  text: string;
  itemCount: number;
}
export interface ArtifactDiscussionSnapshot extends ArtifactDiscussionRead {
  acknowledgment: ArtifactDiscussionAcknowledgment;
}
export interface ArtifactDiscussionAcknowledged {
  acknowledgedCount: number;
}
// Compatible retains restrictive headers without requiring verified network
// enforcement. The browser must obtain risk consent before choosing this mode.
export type ArtifactPreviewNetwork = "blocked" | "compatible" | "external";
// This temporary URL capability grants one artifact/version without application
// credentials. Documents have opaque origins, independent of the transport origin.
export interface ArtifactPreviewContext {
  // An optional, non-authorizing lookup hint for authenticated HTML navigation.
  resumeKey?: string;
  id: string;
  artifactId: string;
  versionSeq: number;
  origin: string;
  resourceRoot: string;
  documentUrl: string;
  gateUrl: string;
  utilityUrl: string;
  presentation: "document" | "media";
  network: ArtifactPreviewNetwork;
  expiresAt: string;
}
export function artifactMediaKind(mediaType: string): "image" | "audio" | "video" | null {
  const kind = mediaType.split("/")[0];
  return kind === "image" || kind === "audio" || kind === "video" ? kind : null;
}
