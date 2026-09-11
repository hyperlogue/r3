// Artifact HTTP contract. Content and message targets always name a publication;
// publisher-local paths and live working trees never participate in reads.

export const ARTIFACT_KINDS = ["files", "html", "diff"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactState = "active" | "archived";
export type Representation = "source" | "rendered" | "diff";
export type ArtifactActor =
  | { role: "human"; sessionId: null }
  | { role: "agent"; sessionId: string };

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

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  state: ArtifactState;
  projectId: string | null;
  title: string | null;
  summary: string | null;
  meta: Record<string, string>;
  createdBy: ArtifactActor;
  nextSeq: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  watching: boolean;
  working: boolean;
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
    | { kind: "files"; entrypoint: null; fileCount: number }
    | { kind: "html"; entrypoint: "index.html" | "index.md"; fileCount: number }
    | { kind: "diff"; entrypoint: null; fileCount: null }
  );

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
  quote: string;
}

export interface RenderedLocator {
  selector: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  route?: string;
  viewport?: { width: number; height: number };
}

export interface DiffLocator extends SourceLocator {
  side: "old" | "new";
}

export type ArtifactDocumentTarget =
  | { kind: "source"; versionSeq: number; path: string; locator: SourceLocator | null }
  | { kind: "rendered"; versionSeq: number; path: string; locator: RenderedLocator | null }
  | { kind: "diff"; versionSeq: number; path: string; locator: DiffLocator | null };

export type ArtifactVersionTarget =
  | ArtifactDocumentTarget
  | { kind: "version_summary"; versionSeq: number; locator: TextQuote | null };

export type ArtifactTarget =
  | { kind: "artifact" }
  | { kind: "artifact_summary"; locator: TextQuote | null }
  | ArtifactVersionTarget;

export type ArtifactMessageContext =
  | { versionSeq: null; representation: null }
  | { versionSeq: number; representation: Representation | null };

export interface ArtifactClaim {
  feedbackId: string;
  sessionId: string;
  claimedAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface ArtifactReply {
  id: string;
  feedbackId: string;
  artifactId: string;
  author: ArtifactActor;
  body: string;
  context: ArtifactMessageContext;
  target: ArtifactVersionTarget | null;
  legacy: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
}

export interface ArtifactFeedback {
  id: string;
  artifactId: string;
  author: ArtifactActor;
  body: string;
  status: "open" | "resolved";
  target: ArtifactTarget;
  legacy: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  statusUnsent: boolean;
  replies: ArtifactReply[];
  claim: ArtifactClaim | null;
}

export interface ArtifactPlacement {
  feedbackId: string;
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
  feedback: ArtifactFeedback[];
  placements: ArtifactPlacement[];
  events: ArtifactLifecycleEvent[];
}

export interface CreateArtifactBody {
  kind: ArtifactKind;
  actor: ArtifactActor;
  projectId?: string | null;
  title?: string | null;
  summary?: string | null;
  meta?: Record<string, string>;
}

// Binary-safe transfer. The version owns the complete path membership. Missing
// members are absent from this version; reads never fall back to its predecessor.
export interface PublicationFile {
  path: string;
  mediaType: string;
  base64: string;
}

export interface PublishArtifactBody {
  expectedSeq: number;
  publicationKey: string;
  actor: ArtifactActor;
  label?: string | null;
  summary?: string | null;
  provenance?: Record<string, unknown>;
  content:
    | { kind: "files"; files: PublicationFile[] }
    | { kind: "html"; files: PublicationFile[]; entrypoint?: "index.html" | "index.md" }
    | { kind: "diff"; patch: string };
}

export interface CreateArtifactFeedbackBody {
  actor: ArtifactActor;
  body: string;
  target: ArtifactTarget;
}

export interface CreateArtifactReplyBody {
  actor: ArtifactActor;
  body: string;
  context: ArtifactMessageContext;
  target?: ArtifactVersionTarget | null;
}

export interface EditArtifactFeedbackBody {
  actor: ArtifactActor;
  body?: string;
  status?: "open" | "resolved";
}

export interface EditArtifactReplyBody {
  actor: ArtifactActor;
  body: string;
}

export interface ArtifactPlacementBody {
  actor: ArtifactActor;
  target: ArtifactDocumentTarget;
  state: ArtifactPlacement["state"];
}

export function hasUnsentArtifactFeedback(feedback: ArtifactFeedback): boolean {
  return (
    (feedback.author.role === "human" && feedback.sentAt === null && feedback.status === "open") ||
    feedback.statusUnsent ||
    feedback.replies.some((reply) => reply.author.role === "human" && reply.sentAt === null)
  );
}

export interface ArtifactLifecycleBody {
  actor: ArtifactActor;
  operationKey: string;
  event: "archived" | "restored";
  message?: string;
}

export type ArtifactStreamEvent =
  | { type: "artifact-updated"; artifactId: string }
  | { type: "artifact-deleted"; artifactId: string }
  | { type: "version-published"; artifactId: string; seq: number }
  | { type: "feedback-updated"; artifactId: string; feedbackId: string }
  | { type: "presence-changed"; artifactId: string }
  | { type: "submitted"; artifactId: string }
  | { type: "lifecycle"; artifactId: string; event: ArtifactLifecycleEvent }
  | { type: "superseded"; artifactId: string };

export const ARTIFACT_WATCH_EXIT = { archived: 0, feedback: 10, timeout: 2, busy: 4 } as const;

export interface ArtifactWatcher {
  id: string;
  kind: "watch" | "listen";
  actor: ArtifactActor;
  connectedAt: string;
}

export interface ArtifactNudge {
  id: string;
  artifactId: string;
  title: string | null;
  event: "submitted" | "archived";
  lifecycleEventId: string | null;
  message: string | null;
}

export type ArtifactNotification =
  | { state: "none" | "sent" | "not_repeated" }
  | { state: "failed"; error: string };

export interface ArtifactLifecycleResponse {
  event: ArtifactLifecycleEvent;
  replayed: boolean;
  notification: ArtifactNotification;
}

export type ArtifactWatchResult =
  | { result: "archived"; event: ArtifactLifecycleEvent | null }
  | { result: "feedback" | "timeout" | "cancelled" | "superseded" | "deleted" };
