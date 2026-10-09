import {
  ArtifactApiError,
  ArtifactClient,
  artifactApiPath,
  discussionApiPath,
} from "../../shared/artifact-client.ts";
import {
  type ArtifactSearchOptions,
  type ArtifactSearchResponse,
  artifactSearchParams,
} from "../../shared/artifact-search.ts";
import type {
  ArtifactGcRequest,
  ArtifactGcResult,
  ArtifactUsage,
  UsageWindow,
} from "../../shared/artifact-usage.ts";
import type {
  AgentSession,
  Artifact,
  ArtifactActor,
  ArtifactComment,
  ArtifactDetail,
  ArtifactDiscussion,
  ArtifactDiscussionAcknowledged,
  ArtifactDiscussionAcknowledgment,
  ArtifactDiscussionRead,
  ArtifactDiscussionSnapshot,
  ArtifactFile,
  ArtifactLifecycleBody,
  ArtifactLifecycleResponse,
  ArtifactNotification,
  ArtifactPlacementBody,
  ArtifactPreviewContext,
  ArtifactPreviewNetwork,
  ArtifactProject,
  ArtifactSource,
  ArtifactSourceRange,
  ArtifactStreamEvent,
  ArtifactTarget,
  ArtifactVersion,
  ArtifactWatcher,
  CreateArtifactCommentBody,
  EditArtifactDiscussionBody,
  EditArtifactProjectBody,
} from "../../shared/artifacts.ts";
import { type AttachmentInput, attachmentPath } from "../../shared/attachments.ts";
import { readEventStream } from "../../shared/event-stream.ts";
import { TOKEN } from "./api.ts";
import { hrefFor } from "./router.ts";
import type { DiffFileChange, DiffLine } from "./types.ts";

export const HUMAN_ACTOR: ArtifactActor = { role: "human", sessionId: null };
const client = () => new ArtifactClient({ url: `${location.origin}${hrefFor("/")}`, token: TOKEN });
const versionPath = (id: string, seq: number) => `${artifactApiPath(id)}/versions/${seq}`;
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  return `?${params}`;
};

// Replaced as a whole by the static demo backend at build time. Presentation
// components use exactly these artifact/version/native-target shapes.
export const artifactApi = {
  stat: (window: UsageWindow = "daily") =>
    client().json<ArtifactUsage>("GET", `/api/stat?window=${window}`),
  gc: (body: ArtifactGcRequest) => client().json<ArtifactGcResult>("POST", "/api/gc", body),
  search: (options: ArtifactSearchOptions, signal?: AbortSignal) =>
    client().json<ArtifactSearchResponse>(
      "GET",
      `/api/search?${artifactSearchParams(options)}`,
      undefined,
      signal,
    ),
  sessions: () => client().json<AgentSession[]>("GET", "/api/sessions"),
  list: (filters: Record<string, string | undefined> = {}) =>
    client().json<Artifact[]>("GET", `/api/artifacts${query(filters)}`),
  detail: (id: string) => client().json<ArtifactDetail>("GET", artifactApiPath(id)),
  discussionSource: (id: string) =>
    client().json<ArtifactSourceRange>("GET", `${discussionApiPath(id)}/source`),
  projects: () => client().json<ArtifactProject[]>("GET", "/api/projects"),
  editProject: (id: string, body: EditArtifactProjectBody) =>
    client().json<ArtifactProject>("PATCH", `/api/projects/${encodeURIComponent(id)}`, body),
  versions: (id: string) =>
    client().json<ArtifactVersion[]>("GET", `${artifactApiPath(id)}/versions`),
  files: (id: string, seq: number) =>
    client().json<ArtifactFile[]>("GET", `${versionPath(id, seq)}/files`),
  source: (id: string, seq: number, path: string, theme?: string) =>
    client().json<ArtifactSource>("GET", `${versionPath(id, seq)}/source${query({ path, theme })}`),
  diff: (id: string, seq: number, theme?: string) =>
    client().json<DiffFileChange[]>("GET", `${versionPath(id, seq)}/diff${query({ theme })}`),
  context: (id: string, seq: number, path: string, start: number, end: number, theme?: string) =>
    client().json<{ path: string; lines: DiffLine[] }>(
      "GET",
      `${versionPath(id, seq)}/diff-context${query({ path, start, end, theme })}`,
    ),
  edit: (id: string, body: { title?: string; summary?: string }) =>
    client().json<Artifact>("PATCH", artifactApiPath(id), body),
  delete: (id: string) => client().json<{ ok: boolean }>("DELETE", artifactApiPath(id)),
  addDiscussion: (
    id: string,
    body: string,
    target: ArtifactTarget,
    options: {
      attachments?: AttachmentInput[];
      operationKey?: string;
      mediaSnapshot?: AttachmentInput;
    } = {},
  ) =>
    client().json<ArtifactDiscussion>("POST", `${artifactApiPath(id)}/discussions`, {
      actor: HUMAN_ACTOR,
      body,
      target,
      ...options,
    }),
  editDiscussion: (id: string, body: Omit<EditArtifactDiscussionBody, "actor">) =>
    client().json<ArtifactDiscussion>("PATCH", discussionApiPath(id), {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  deleteDiscussion: (id: string) =>
    client().json<{ ok: boolean }>("DELETE", discussionApiPath(id), { actor: HUMAN_ACTOR }),
  comment: (id: string, body: Omit<CreateArtifactCommentBody, "actor">) =>
    client().json<ArtifactComment>("POST", `${discussionApiPath(id)}/comments`, {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  editComment: (id: string, body: string, attachments?: AttachmentInput[]) =>
    client().json<ArtifactComment>("PATCH", `/api/comments/${encodeURIComponent(id)}`, {
      actor: HUMAN_ACTOR,
      body,
      attachments,
    }),
  attachment: (artifactId: string, id: string) =>
    client().request("GET", attachmentPath(artifactId, id)),
  place: (id: string, body: Omit<ArtifactPlacementBody, "actor">) =>
    client().json("PUT", `${discussionApiPath(id)}/placements`, { ...body, actor: HUMAN_ACTOR }),
  lifecycle: async (id: string, body: Omit<ArtifactLifecycleBody, "actor">) => {
    try {
      return await client().json<ArtifactLifecycleResponse>(
        "POST",
        `${artifactApiPath(id)}/lifecycle`,
        {
          ...body,
          actor: HUMAN_ACTOR,
        },
      );
    } catch (error) {
      // Notification failure follows a committed transition. Keep that outcome
      // visible instead of inviting another archive with a new operation key.
      if (error instanceof ArtifactApiError && error.status === 502) {
        const result = error.result as ArtifactLifecycleResponse | null;
        if (result?.event?.artifactId === id && result.notification?.state === "failed")
          return result;
      }
      throw error;
    }
  },
  watchers: (id: string) =>
    client().json<ArtifactWatcher[]>("GET", `${artifactApiPath(id)}/watchers`),
  submit: (id: string) =>
    client().json<{ notification: ArtifactNotification }>("POST", `${artifactApiPath(id)}/submit`),
  pendingDiscussion: (id: string, discussions?: string[]) =>
    client().json<ArtifactDiscussionSnapshot>(
      "GET",
      `${artifactApiPath(id)}/discussions/pending${query({ discussions: discussions?.join(",") })}`,
    ),
  discussionHistory: (id: string, discussions?: string[]) =>
    client().json<ArtifactDiscussionRead>(
      "GET",
      `${artifactApiPath(id)}/discussions/history${query({ discussions: discussions?.join(",") })}`,
    ),
  acknowledgeDiscussion: (id: string, body: ArtifactDiscussionAcknowledgment) =>
    client().json<ArtifactDiscussionAcknowledged>(
      "POST",
      `${artifactApiPath(id)}/discussions/acknowledge`,
      body,
    ),
  viewed: (id: string) => client().json<string[]>("GET", `${artifactApiPath(id)}/viewed`),
  setViewed: (id: string, key: string, viewed: boolean) =>
    client().json("PUT", `${artifactApiPath(id)}/viewed`, { key, viewed }),
  download: (id: string, seq: number, path: string) =>
    client().request("GET", `${versionPath(id, seq)}/resource${query({ path })}`),
  createPreview: (
    id: string,
    seq: number,
    path: string,
    network: ArtifactPreviewNetwork = "blocked",
  ) =>
    client().json<ArtifactPreviewContext>("POST", `${versionPath(id, seq)}/previews`, {
      path,
      network,
    }),
  renewPreview: (id: string) =>
    client().json<ArtifactPreviewContext>("PATCH", `/api/previews/${encodeURIComponent(id)}`),
  revokePreview: (id: string) => client().json("DELETE", `/api/previews/${encodeURIComponent(id)}`),
};

export async function* artifactEventStream(
  signal: AbortSignal,
): AsyncGenerator<ArtifactStreamEvent | { type: "ready" }> {
  const response = await client().request("GET", "/api/events", undefined, signal);
  if (!response.body) throw new Error("Missing event stream");
  for await (const frame of readEventStream(response.body)) {
    if (frame.event === "ready") yield { type: "ready" };
    else if (frame.event !== "heartbeat") yield JSON.parse(frame.data) as ArtifactStreamEvent;
  }
}
