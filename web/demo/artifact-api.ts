import { buildArtifactPrompt, feedbackAttachments } from "../../shared/artifact-prompt.ts";
import {
  type ArtifactFeedback,
  type ArtifactReply,
  type ArtifactStreamEvent,
  type ArtifactTarget,
  artifactAgentIds,
} from "../../shared/artifacts.ts";
import {
  type ArtifactAttachment,
  ATTACHMENT_LIMITS,
  type AttachmentInput,
} from "../../shared/attachments.ts";
import { normalizeGitRemote } from "../../shared/git-remote.ts";
import type { artifactApi as productionApi } from "../src/artifact-api.ts";
import { draftImages, prepareDraftImage } from "../src/attachment-drafts.ts";
import { demo, fail, human, mint, now } from "./artifact-backend.ts";
import { searchDemoArtifacts } from "./artifact-search.ts";
import { demoGcPreview, demoUsage } from "./artifact-usage.ts";

export { human as HUMAN_ACTOR };

const copy = <T>(value: T): T => structuredClone(value);
async function mediaEvidence<T extends ArtifactTarget | null | undefined>(
  id: string,
  target: T,
  snapshot?: AttachmentInput,
): Promise<T> {
  if (target?.kind !== "media") {
    if (snapshot) fail("A media snapshot requires a media target");
    return target;
  }
  if (!snapshot || "id" in snapshot) fail("A media target requires a full-frame snapshot");
  const [frame] = await attachments(id, [snapshot]);
  return { ...target, locator: { ...target.locator, frame } };
}

async function attachments(
  artifactId: string,
  inputs: AttachmentInput[] | undefined,
  current: ArtifactAttachment[] = [],
): Promise<ArtifactAttachment[]> {
  if (inputs === undefined) return current;
  if (inputs.length > ATTACHMENT_LIMITS.count) fail("A message can contain at most four images");
  const result: ArtifactAttachment[] = [];
  for (const input of inputs) {
    if ("id" in input) {
      const held = current.find((image) => image.id === input.id);
      if (!held || result.some((image) => image.id === held.id))
        fail("Attachment does not belong to this message");
      result.push(held!);
      continue;
    }
    const bytes = Uint8Array.from(atob(input.base64), (value) => value.charCodeAt(0));
    const prepared = await prepareDraftImage(
      artifactId,
      new Blob([bytes], { type: input.mediaType }),
      input.capture,
    );
    const blob = await draftImages.get(prepared.attachment.id);
    const id = `image_${crypto.randomUUID().replaceAll("-", "")}`;
    demo.images.set(id, { artifactId, blob });
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    result.push({ ...prepared.attachment, id, artifactId, hash });
  }
  return result;
}

async function messageOperation(
  artifactId: string,
  kind: "feedback" | "reply",
  key: string | undefined,
  input: unknown,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const index = JSON.stringify([artifactId, key]);
  return {
    replay() {
      if (!key) return null;
      const saved = demo.state.messageOperations?.[index];
      if (!saved) return null;
      if (saved.hash !== hash || saved.kind !== kind)
        fail("Operation key was used for a different message", 409);
      return saved.kind === "feedback"
        ? copy(demo.note(saved.id).note)
        : copy(demo.reply(saved.id).reply);
    },
    save(id: string) {
      if (key) {
        demo.state.messageOperations ??= {};
        demo.state.messageOperations[index] = { hash, id, kind, artifactId };
      }
    },
  };
}

export const artifactApi: typeof productionApi = {
  stat: async (window = "daily") => copy(demoUsage(demo.state, window, now())),
  gc: async (input) => {
    const result = demoGcPreview(demo.state, input, now());
    if (!result.dryRun)
      for (const row of result.candidates) {
        try {
          await artifactApi.delete(row.id);
          result.deletedIds.push(row.id);
        } catch {
          result.failures.push({ id: row.id, error: "Artifact deletion failed" });
        }
      }
    return result;
  },
  search: async (options) => copy(searchDemoArtifacts(demo.state, options)),
  feedbackSource: async (id) => demo.feedbackSource(id),
  sessions: async () =>
    [
      ...new Set(
        demo.state.artifacts
          .flatMap((artifact) => [
            artifact.createdBy.sessionId,
            ...artifact.versions.map((version) => version.publishedBy.sessionId),
            ...artifact.feedback.flatMap((feedback) => [
              feedback.author.sessionId,
              ...feedback.replies.map((reply) => reply.author.sessionId),
            ]),
          ])
          .filter((id): id is string => id !== null),
      ),
    ].map((id) => ({
      id,
      harness: "demo",
      label: "Demo agent",
      createdAt: now(),
    })),
  list: async (filters = {}) =>
    copy(
      demo.state.artifacts
        .map((item) => ({ ...item, latestVersion: item.versions.at(-1) ?? null }))
        .filter(
          (item) =>
            (!filters.state || item.state === filters.state) &&
            (!filters.kind || item.kind === filters.kind) &&
            (!filters.projectId || item.projectId === filters.projectId),
        ),
    ),
  detail: async (id) => {
    const detail = copy(demo.get(id));
    detail.agentLabels = Object.fromEntries(
      artifactAgentIds(detail).map((id) => [id, "Demo agent"]),
    );
    return detail;
  },
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
    Object.assign(demo.requireActive(id), body);
    demo.changed(id);
    return copy(demo.get(id));
  },
  delete: async (id) => {
    for (const note of demo.get(id).feedback) delete demo.state.everDelivered[note.id];
    delete demo.state.feedbackRevisions[id];
    demo.state.artifacts = demo.state.artifacts.filter((item) => item.id !== id);
    for (const key of Object.keys(demo.state.publications))
      if (key.startsWith(`${id}/`)) delete demo.state.publications[key];
    delete demo.state.pending[id];
    delete demo.state.viewed[id];
    for (const [key, operation] of Object.entries(demo.state.messageOperations ?? {}))
      if (operation.artifactId === id) delete demo.state.messageOperations![key];
    for (const [imageId, image] of demo.images)
      if (image.artifactId === id) demo.images.delete(imageId);
    for (const listener of demo.subscribers) listener({ type: "artifact-deleted", artifactId: id });
    return { ok: true };
  },
  addFeedback: async (id, body, target, options = {}) => {
    demo.target(id, target);
    const operation = await messageOperation(id, "feedback", options.operationKey, {
      body,
      target,
      attachments: options.attachments,
      mediaSnapshot: options.mediaSnapshot,
    });
    const replay = operation.replay();
    if (replay) return replay as ArtifactFeedback;
    const images = await attachments(id, options.attachments);
    const accepted = await mediaEvidence(id, target, options.mediaSnapshot);
    const concurrent = operation.replay();
    if (concurrent) return concurrent as ArtifactFeedback;
    const note = demo.addFeedback(id, body, accepted!, images);
    operation.save(note.id);
    return note;
  },
  attachment: async (artifactId, id) => {
    const images = feedbackAttachments(demo.get(artifactId).feedback);
    if (!images.some((image) => image.id === id)) fail("Attachment not found", 404);
    return new Response(demo.images.get(id)?.blob ?? fail("Attachment not found", 404));
  },
  editFeedback: async (id, body) => {
    const { artifact, note } = demo.note(id);
    const nextImages = await attachments(artifact.id, body.attachments, note.attachments);
    demo.requireActive(artifact.id);
    const imagesChanged = JSON.stringify(nextImages) !== JSON.stringify(note.attachments ?? []);
    if (!(body.body ?? note.body).trim() && !nextImages.length)
      fail("A message needs text or an image");
    note.attachments = nextImages;
    const previousBody = note.body;
    const previousStatus = note.status;
    if (body.body !== undefined) {
      note.body = body.body;
    }
    if (body.status !== undefined && body.status !== note.status) {
      note.status = body.status;
      if (note.status === "resolved") note.claim = null;
    }
    if (
      note.author.role === "human" &&
      note.status === "open" &&
      (note.body !== previousBody || imagesChanged)
    )
      note.sentAt = null;
    note.statusUnsent ||= note.status !== previousStatus && demo.state.everDelivered[id] === true;
    note.updatedAt = now();
    artifact.working = artifact.feedback.some((item) => item.claim !== null);
    demo.changed(artifact.id);
    return copy(note);
  },
  deleteFeedback: async (id) => {
    const { artifact } = demo.note(id);
    demo.requireActive(artifact.id);
    delete demo.state.everDelivered[id];
    for (const [key, operation] of Object.entries(demo.state.messageOperations ?? {}))
      if (
        operation.id === id ||
        artifact.feedback
          .find((note) => note.id === id)
          ?.replies.some((reply) => reply.id === operation.id)
      )
        delete demo.state.messageOperations![key];
    artifact.feedback = artifact.feedback.filter((item) => item.id !== id);
    artifact.placements = artifact.placements.filter((item) => item.feedbackId !== id);
    artifact.working = artifact.feedback.some((item) => item.claim !== null);
    demo.changed(artifact.id);
    return { ok: true };
  },
  reply: async (id, body) => {
    const { artifact, note } = demo.note(id);
    const operation = await messageOperation(artifact.id, "reply", body.operationKey, { id, body });
    const replay = operation.replay();
    if (replay) return replay as ArtifactReply;
    const images = await attachments(artifact.id, body.attachments);
    const acceptedTarget = await mediaEvidence(artifact.id, body.target, body.mediaSnapshot);
    const concurrent = operation.replay();
    if (concurrent) return concurrent as ArtifactReply;
    demo.requireActive(artifact.id);
    if (!body.body.trim() && !images.length) fail("A reply needs text or an image");
    if (body.context.versionSeq !== null) demo.publication(artifact.id, body.context.versionSeq);
    if (body.target) demo.target(artifact.id, body.target);
    const reply = {
      id: mint("reply"),
      artifactId: artifact.id,
      feedbackId: id,
      author: human,
      body: body.body,
      attachments: images,
      context: copy(body.context),
      target: copy(acceptedTarget ?? null),
      legacy: null,
      createdAt: now(),
      sentAt: null,
    };
    note.replies.push(reply);
    operation.save(reply.id);
    demo.changed(artifact.id);
    return copy(reply);
  },
  editReply: async (id, body, inputs) => {
    const { artifact, reply } = demo.reply(id);
    const images = await attachments(artifact.id, inputs, reply.attachments);
    demo.requireActive(artifact.id);
    if (!body.trim() && !images.length) fail("A reply needs text or an image");
    if (reply.body !== body || JSON.stringify(images) !== JSON.stringify(reply.attachments ?? [])) {
      reply.attachments = images;
      reply.body = body;
      if (reply.author.role === "human") reply.sentAt = null;
    }
    demo.changed(artifact.id);
    return copy(reply);
  },
  place: async (id, body) => {
    const { artifact } = demo.note(id);
    demo.requireActive(artifact.id);
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
      fail("No listener is registered; run r3 feedback fetch in your agent", 409);
    demo.handoff(id);
    return { notification: { state: "sent" } };
  },
  pendingFeedback: (id, feedback) => demo.snapshot(id, feedback),
  feedbackHistory: async (id, feedback) => {
    const artifact = demo.get(id);
    const selected = artifact.feedback.filter((note) =>
      feedback ? feedback.includes(note.id) : note.status === "open",
    );
    return {
      text: buildArtifactPrompt(artifact, selected),
      itemCount: selected.length,
      attachments: feedbackAttachments(selected),
    };
  },
  acknowledgeFeedback: async (id, body) => {
    if (!/^[a-f0-9]{64}$/.test(body.expectedFingerprint ?? ""))
      fail("Invalid feedback fingerprint");
    const revision = demo.state.feedbackRevisions[id];
    const snapshot = await demo.snapshot(id, body.feedback);
    if (
      revision !== demo.state.feedbackRevisions[id] ||
      body.expectedFingerprint !== snapshot.acknowledgment.expectedFingerprint
    )
      fail("Feedback changed; fetch it again before acknowledging", 409);
    demo.handoff(id, body.feedback);
    return { acknowledgedCount: snapshot.itemCount };
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
