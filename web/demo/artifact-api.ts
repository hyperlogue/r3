import { buildArtifactPrompt } from "../../shared/artifact-prompt.ts";
import type { ArtifactStreamEvent } from "../../shared/artifacts.ts";
import { normalizeGitRemote } from "../../shared/git-remote.ts";
import type { artifactApi as productionApi } from "../src/artifact-api.ts";
import { demo, fail, human, mint, now } from "./artifact-backend.ts";

export { human as HUMAN_ACTOR };

const copy = <T>(value: T): T => structuredClone(value);

export const artifactApi: typeof productionApi = {
  list: async (filters = {}) =>
    copy(
      demo.state.artifacts.filter(
        (item) =>
          (!filters.state || item.state === filters.state) &&
          (!filters.kind || item.kind === filters.kind) &&
          (!filters.projectId || item.projectId === filters.projectId),
      ),
    ),
  detail: async (id) => copy(demo.get(id)),
  projects: async () => copy(demo.state.projects),
  editProject: async (id, body) => {
    const project =
      demo.state.projects.find((item) => item.id === id) ?? fail("Project not found", 404);
    if ("expectedRemoteUrl" in body && body.expectedRemoteUrl !== project.remoteUrl)
      fail("Project remote changed; fetch the project before retrying", 409);
    const remote = body.remoteUrl == null ? null : normalizeGitRemote(body.remoteUrl);
    if (body.remoteUrl != null && !remote) fail("Project remote must be a network Git URL");
    if (
      remote &&
      demo.state.projects.some(
        (item) => item.id !== id && normalizeGitRemote(item.remoteUrl)?.key === remote.key,
      )
    )
      fail("Remote already belongs to another project; use an explicit project mapping", 409);
    if ("name" in body) project.name = body.name?.trim() || null;
    if ("remoteUrl" in body) project.remoteUrl = remote?.url ?? null;
    demo.persist();
    for (const artifact of demo.state.artifacts)
      if (artifact.projectId === id) demo.changed(artifact.id);
    return copy(project);
  },
  versions: async (id) => copy(demo.get(id).versions),
  files: async (id, seq) => copy(demo.publication(id, seq).files),
  source: async (id, seq, path) =>
    copy(demo.publication(id, seq).sources[path] ?? fail("File not found", 404)),
  diff: async (id, seq) => copy(demo.publication(id, seq).diff),
  context: async (id, seq, path, start, end) => {
    const file = demo
      .publication(id, seq)
      .fullDiff.find((file) => file.path === path || file.oldPath === path);
    const lines = file?.lines.filter(
      (line) =>
        line.type === "context" &&
        line.newLine !== null &&
        line.newLine >= start &&
        line.newLine <= end,
    );
    if (!lines || lines.length !== end - start + 1)
      fail("This publication has no captured context for that range", 404);
    return copy({ path, lines });
  },
  edit: async (id, body) => {
    if ("summary" in body) fail("Artifact overview was removed; publish a version summary instead");
    Object.assign(demo.get(id), body);
    demo.changed(id);
    return copy(demo.get(id));
  },
  delete: async (id) => {
    demo.get(id);
    demo.state.artifacts = demo.state.artifacts.filter((item) => item.id !== id);
    for (const key of Object.keys(demo.state.publications))
      if (key.startsWith(`${id}/`)) delete demo.state.publications[key];
    delete demo.state.pending[id];
    delete demo.state.viewed[id];
    demo.persist();
    for (const listener of demo.subscribers) listener({ type: "artifact-deleted", artifactId: id });
    return { ok: true };
  },
  addFeedback: async (id, body, target) => demo.addFeedback(id, body, target),
  editFeedback: async (id, body) => {
    const { artifact, note } = demo.note(id);
    const previousBody = note.body;
    const previousStatus = note.status;
    const previousSentAt = note.sentAt;
    if (body.body !== undefined) {
      if (!body.body.trim()) fail("Feedback requires a message");
      note.body = body.body;
    }
    if (body.status !== undefined && body.status !== note.status) {
      note.status = body.status;
      if (note.status === "resolved") note.claim = null;
    }
    if (note.author.role === "human" && note.status === "open" && note.body !== previousBody)
      note.sentAt = null;
    note.statusUnsent ||= note.status !== previousStatus && previousSentAt !== null;
    note.updatedAt = now();
    artifact.working = artifact.feedback.some((item) => item.claim !== null);
    demo.changed(artifact.id);
    return copy(note);
  },
  deleteFeedback: async (id) => {
    const { artifact } = demo.note(id);
    artifact.feedback = artifact.feedback.filter((item) => item.id !== id);
    artifact.placements = artifact.placements.filter((item) => item.feedbackId !== id);
    artifact.working = artifact.feedback.some((item) => item.claim !== null);
    demo.changed(artifact.id);
    return { ok: true };
  },
  reply: async (id, body) => {
    const { artifact, note } = demo.note(id);
    if (!body.body.trim()) fail("A reply requires a message");
    if (body.context.versionSeq !== null) demo.publication(artifact.id, body.context.versionSeq);
    if (body.target) demo.target(artifact.id, body.target);
    const reply = {
      id: mint("reply"),
      artifactId: artifact.id,
      feedbackId: id,
      author: human,
      body: body.body,
      context: copy(body.context),
      target: copy(body.target ?? null),
      legacy: null,
      createdAt: now(),
      sentAt: null,
    };
    note.replies.push(reply);
    demo.changed(artifact.id);
    return copy(reply);
  },
  editReply: async (id, body) => {
    const { artifact, reply } = demo.reply(id);
    if (!body.trim()) fail("A reply requires a message");
    if (reply.body !== body) {
      reply.body = body;
      if (reply.author.role === "human") reply.sentAt = null;
    }
    demo.changed(artifact.id);
    return copy(reply);
  },
  place: async (id, body) => {
    const { artifact } = demo.note(id);
    demo.target(artifact.id, body.target);
    const index = artifact.placements.findIndex(
      (item) =>
        item.feedbackId === id &&
        item.target.kind === body.target.kind &&
        item.target.path === body.target.path &&
        item.target.versionSeq === body.target.versionSeq,
    );
    const placement = {
      feedbackId: id,
      artifactId: artifact.id,
      ...copy(body),
      createdAt: index < 0 ? now() : artifact.placements[index].createdAt,
      updatedAt: now(),
    };
    if (index < 0) artifact.placements.push(placement);
    else artifact.placements[index] = placement;
    demo.changed(artifact.id);
    return copy(placement);
  },
  lifecycle: async (id, body) => demo.lifecycle(id, body),
  watchers: async (id) =>
    demo.get(id).watching
      ? [
          {
            id: `listener_${id}`,
            kind: "listen",
            actor: { role: "agent", sessionId: "demo-agent" },
            connectedAt: demo.get(id).createdAt,
          },
        ]
      : [],
  submit: async (id) => {
    if (!demo.get(id).watching)
      fail("No listener is registered; copy the prompt to hand it to an agent", 409);
    demo.handoff(id);
    return { notification: { state: "sent" } };
  },
  prompt: async (id, acknowledge = false, feedback) => {
    const selected = demo.pending(id);
    const text = buildArtifactPrompt(
      demo.get(id),
      feedback ? selected.filter((item) => feedback.includes(item.id)) : selected,
      true,
    );
    if (acknowledge) demo.handoff(id, feedback);
    return text;
  },
  previewPrompt: async (id) => ({ text: demo.prompt(id), fingerprint: demo.fingerprint(id) }),
  acknowledgePrompt: async (id, expectedFingerprint) => {
    if (demo.fingerprint(id) !== expectedFingerprint)
      fail("Feedback changed; copy the new prompt before sending", 409);
    demo.handoff(id);
    return new Response(null, { status: 204 });
  },
  viewed: async (id) => {
    demo.get(id);
    return copy(demo.state.viewed[id] ?? []);
  },
  setViewed: async (id, key, viewed) => {
    demo.get(id);
    const keys = new Set(demo.state.viewed[id]);
    if (viewed) keys.add(key);
    else keys.delete(key);
    demo.state.viewed[id] = [...keys];
    demo.persist();
    return { ok: true };
  },
  download: async (id, seq, path) => {
    const publication = demo.publication(id, seq);
    const resource = publication.resources[path] ?? fail("File not found", 404);
    const file = publication.files.find((file) => file.path === path)!;
    return new Response(
      Uint8Array.from(atob(resource), (character) => character.charCodeAt(0)),
      { headers: { "content-type": file.mediaType, "content-disposition": "attachment" } },
    );
  },
  createPreview: async () =>
    fail(
      "Server preview contexts are unavailable in the static demo. Bundled examples use the demo renderer.",
      503,
    ),
  renewPreview: async () => fail("Server preview contexts are unavailable in the static demo", 503),
  revokePreview: async () => ({ ok: true }),
};

export async function* artifactEventStream(
  signal: AbortSignal,
): AsyncGenerator<ArtifactStreamEvent | { type: "ready" }> {
  const queue: ArtifactStreamEvent[] = [];
  let wake: (() => void) | null = null;
  const listener = (event: ArtifactStreamEvent) => {
    queue.push(copy(event));
    wake?.();
  };
  const stop = () => wake?.();
  demo.subscribers.add(listener);
  signal.addEventListener("abort", stop);
  try {
    yield { type: "ready" };
    while (!signal.aborted) {
      if (!queue.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (signal.aborted || queue.length) resolve();
        });
      while (!signal.aborted && queue.length) yield queue.shift()!;
    }
  } finally {
    demo.subscribers.delete(listener);
    signal.removeEventListener("abort", stop);
  }
}
