import {
  ArtifactApiError,
  ArtifactClient,
  artifactApiPath,
  feedbackApiPath,
} from "../../shared/artifact-client.ts";
import type {
  AgentSession,
  Artifact,
  ArtifactActor,
  ArtifactDetail,
  ArtifactFeedback,
  ArtifactFeedbackAcknowledged,
  ArtifactFeedbackAcknowledgment,
  ArtifactFeedbackRead,
  ArtifactFeedbackSnapshot,
  ArtifactFile,
  ArtifactLifecycleBody,
  ArtifactLifecycleResponse,
  ArtifactNotification,
  ArtifactPlacementBody,
  ArtifactPreviewContext,
  ArtifactPreviewNetwork,
  ArtifactProject,
  ArtifactReply,
  ArtifactSource,
  ArtifactStreamEvent,
  ArtifactTarget,
  ArtifactVersion,
  ArtifactWatcher,
  CreateArtifactReplyBody,
  EditArtifactFeedbackBody,
  EditArtifactProjectBody,
} from "../../shared/artifacts.ts";
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
  sessions: () => client().json<AgentSession[]>("GET", "/api/sessions"),
  list: (filters: Record<string, string | undefined> = {}) =>
    client().json<Artifact[]>("GET", `/api/artifacts${query(filters)}`),
  detail: (id: string) => client().json<ArtifactDetail>("GET", artifactApiPath(id)),
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
  addFeedback: (id: string, body: string, target: ArtifactTarget) =>
    client().json<ArtifactFeedback>("POST", `${artifactApiPath(id)}/feedback`, {
      actor: HUMAN_ACTOR,
      body,
      target,
    }),
  editFeedback: (id: string, body: Omit<EditArtifactFeedbackBody, "actor">) =>
    client().json<ArtifactFeedback>("PATCH", feedbackApiPath(id), { ...body, actor: HUMAN_ACTOR }),
  deleteFeedback: (id: string) =>
    client().json<{ ok: boolean }>("DELETE", feedbackApiPath(id), { actor: HUMAN_ACTOR }),
  reply: (id: string, body: Omit<CreateArtifactReplyBody, "actor">) =>
    client().json<ArtifactReply>("POST", `${feedbackApiPath(id)}/replies`, {
      ...body,
      actor: HUMAN_ACTOR,
    }),
  editReply: (id: string, body: string) =>
    client().json<ArtifactReply>("PATCH", `/api/replies/${encodeURIComponent(id)}`, {
      actor: HUMAN_ACTOR,
      body,
    }),
  place: (id: string, body: Omit<ArtifactPlacementBody, "actor">) =>
    client().json("PUT", `${feedbackApiPath(id)}/placements`, { ...body, actor: HUMAN_ACTOR }),
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
  pendingFeedback: (id: string, feedback?: string[]) =>
    client().json<ArtifactFeedbackSnapshot>(
      "GET",
      `${artifactApiPath(id)}/feedback/pending${query({ feedback: feedback?.join(",") })}`,
    ),
  feedbackHistory: (id: string, feedback?: string[]) =>
    client().json<ArtifactFeedbackRead>(
      "GET",
      `${artifactApiPath(id)}/feedback/history${query({ feedback: feedback?.join(",") })}`,
    ),
  acknowledgeFeedback: (id: string, body: ArtifactFeedbackAcknowledgment) =>
    client().json<ArtifactFeedbackAcknowledged>(
      "POST",
      `${artifactApiPath(id)}/feedback/acknowledge`,
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
