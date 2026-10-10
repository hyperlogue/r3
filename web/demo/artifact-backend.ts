import { ArtifactApiError } from "../../shared/artifact-client.ts";
import { buildArtifactPrompt, commentAttachments } from "../../shared/artifact-prompt.ts";
import type {
  ArtifactComment,
  ArtifactCommentSnapshot,
  ArtifactLifecycleBody,
  ArtifactLifecycleEvent,
  ArtifactLifecycleResponse,
  ArtifactSourceRange,
  ArtifactStreamEvent,
  ArtifactTarget,
  ArtifactThread,
} from "../../shared/artifacts.ts";
import {
  artifactReferenceContext,
  hasUnsentArtifactThread,
  isUnhandledArtifactThread,
} from "../../shared/artifacts.ts";
import type { ArtifactAttachment } from "../../shared/attachments.ts";
import { animatedImage, targetableMedia } from "../../shared/media-target.ts";
import { ARTIFACT_DEMO_SEED } from "./artifact-fixtures.gen.ts";
import {
  type ArtifactDemoSeed,
  type ArtifactDemoState,
  demoStorageUsage,
  publicationKey,
} from "./artifact-model.ts";
import { syncDemoActivity } from "./artifact-usage.ts";

const actor = { role: "agent" as const, sessionId: "demo-agent" };
export const human = { role: "human" as const, sessionId: null };
export const now = () => new Date().toISOString();
export const mint = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
export function fail(message: string, status = 400): never {
  throw new ArtifactApiError(status, null, message);
}
export class ArtifactDemoBackend {
  state: ArtifactDemoState;
  readonly subscribers = new Set<(event: ArtifactStreamEvent) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly images = new Map<
    string,
    {
      artifactId: string;
      blob: Blob;
    }
  >();
  constructor(private fixtures: ArtifactDemoSeed = ARTIFACT_DEMO_SEED) {
    this.state = this.seed();
  }
  private seed(): ArtifactDemoState {
    const seed = structuredClone(this.fixtures);
    const state: ArtifactDemoState = {
      ...seed,
      discussionRevisions: {},
      viewed: {},
      everDelivered: Object.fromEntries(
        seed.artifacts.flatMap((artifact) =>
          artifact.threads.map((note) => [
            note.id,
            note.comments[0]!.sentAt !== null || note.statusUnsent,
          ]),
        ),
      ),
    };
    syncDemoActivity(state);
    return state;
  }
  reset(fixtures = this.fixtures) {
    this.close();
    this.fixtures = fixtures;
    this.state = this.seed();
    this.images.clear();
  }
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  get(id: string) {
    return (
      this.state.artifacts.find((artifact) => artifact.id === id) ?? fail("Artifact not found", 404)
    );
  }
  requireActive(id: string) {
    const artifact = this.get(id);
    if (artifact.state !== "active") fail("Artifact is archived", 409);
    return artifact;
  }
  note(id: string) {
    for (const artifact of this.state.artifacts) {
      const note = artifact.threads.find((note) => note.id === id);
      if (note) return { artifact, note };
    }
    return fail("Thread not found", 404);
  }
  comment(id: string) {
    for (const artifact of this.state.artifacts)
      for (const note of artifact.threads) {
        const comment = note.comments.find((comment) => comment.id === id);
        if (comment) return { artifact, note, comment };
      }
    for (const artifact of this.state.artifacts) {
      const event = artifact.events.find((event) => event.comment?.id === id);
      if (event?.comment) return { artifact, note: null, comment: event.comment };
    }
    return fail("Comment not found", 404);
  }
  publication(id: string, seq: number) {
    this.get(id);
    return this.state.publications[publicationKey(id, seq)] ?? fail("Version not found", 404);
  }
  private storageUsage(id: string) {
    return demoStorageUsage(
      this.get(id).versions.map(
        (version) => this.state.publications[publicationKey(id, version.seq)]!,
      ),
    );
  }
  changed(id: string, event?: ArtifactStreamEvent) {
    const artifact = this.get(id);
    artifact.updatedAt = now();
    this.state.discussionRevisions[id] = (this.state.discussionRevisions[id] ?? 0) + 1;
    artifact.unhandledCount = artifact.threads.filter(isUnhandledArtifactThread).length;
    artifact.storage = this.storageUsage(id);
    syncDemoActivity(this.state);
    for (const listener of this.subscribers) {
      listener(event ?? { type: "artifact-updated", artifactId: id });
      listener({ type: "presence-changed", artifactId: id });
    }
  }
  target(id: string, target: ArtifactTarget) {
    const detail = this.get(id);
    if (target.kind === "artifact_summary")
      fail("Artifact overview targets are read-only historical evidence");
    if (target.kind === "version_summary")
      fail("Version description targets are read-only historical evidence");
    if (!("versionSeq" in target)) return;
    const content = this.publication(id, target.versionSeq);
    if (detail.kind === "diff" ? target.kind !== "diff" : target.kind === "diff")
      fail("Target representation does not belong to this artifact");
    if (target.kind === "media") {
      const file = content.files.find((file) => file.path === target.path);
      if (detail.kind !== "files" || !file)
        fail("Media targets require a file in a files publication");
      const media = targetableMedia(file.mediaType);
      if (
        !media ||
        (media === "image" &&
          animatedImage(
            Uint8Array.from(atob(content.resources[file.path] ?? ""), (c) => c.charCodeAt(0)),
            file.mediaType,
          ))
      )
        fail("This file does not support media targets");
      const { time, box } = target.locator;
      if (
        media === "image"
          ? time !== null
          : typeof time !== "number" || !Number.isFinite(time) || time < 0
      )
        fail("Invalid media timestamp");
      if (
        !box ||
        ![box.x, box.y, box.width, box.height].every(
          (n) => Number.isFinite(n) && n >= 0 && n <= 1,
        ) ||
        !box.width ||
        !box.height ||
        box.x + box.width > 1.000000001 ||
        box.y + box.height > 1.000000001
      )
        fail("Invalid media box");
      return;
    }
    if (target.kind === "diff") {
      const file = content.fullDiff.find(
        (file) => file.path === target.path || file.oldPath === target.path,
      );
      if (!file) fail("File not found in this version", 404);
      if (target.locator) {
        const { start, end, side, quote } = target.locator;
        const rows = file.lines.filter((line) => {
          const number = side === "old" ? line.oldLine : line.newLine;
          return number !== null && number >= start && number <= end;
        });
        if (
          rows.length !== end - start + 1 ||
          rows.some((row, i) => (side === "old" ? row.oldLine : row.newLine) !== start + i) ||
          !quote.trim() ||
          !rows
            .map((line) => line.text)
            .join("\n")
            .includes(quote)
        )
          fail("The target does not match captured diff rows");
      }
    } else {
      const source = content.sources[target.path];
      if (!source) fail("File not found in this version", 404);
      if (target.kind === "source" && target.locator) {
        const { start, end, quote } = target.locator;
        if (
          start < 1 ||
          end < start ||
          end > source.lines.length ||
          !quote.trim() ||
          !source.lines
            .slice(start - 1, end)
            .map((line) => line.text)
            .join("\n")
            .includes(quote)
        )
          fail("The target does not match published source");
      }
    }
  }
  threadSource(id: string): ArtifactSourceRange {
    const { artifact, note } = this.note(id);
    const target = note.target;
    if ((target.kind !== "source" && target.kind !== "diff") || !target.locator)
      fail("Thread has no captured source or diff line range");
    this.target(artifact.id, target);
    const { versionSeq, path, locator } = target;
    const { start, end } = locator;
    const content = this.publication(artifact.id, versionSeq);
    const side = target.kind === "diff" ? target.locator!.side : null;
    const lines =
      target.kind === "diff"
        ? content.fullDiff
            .find((file) => file.path === path || file.oldPath === path)!
            .lines.filter((row) => {
              const line = side === "old" ? row.oldLine : row.newLine;
              return line !== null && line >= start && line <= end;
            })
        : content.sources[path].lines.slice(start - 1, end);
    return {
      artifactId: artifact.id,
      versionSeq,
      path,
      side,
      start,
      end,
      text: lines.map((row) => row.text).join("\n"),
    };
  }
  addThread(
    id: string,
    body: string,
    target: ArtifactTarget,
    attachments: ArtifactAttachment[] = [],
  ): ArtifactThread {
    if (!body.trim() && !attachments.length) fail("Thread needs text or an image");
    this.requireActive(id);
    this.target(id, target);
    const time = now();
    const threadId = mint("thread");
    const note: ArtifactThread = {
      id: threadId,
      artifactId: id,
      status: "open",
      target: structuredClone(target),
      createdAt: time,
      updatedAt: time,
      statusUnsent: false,
      claim: null,
      comments: [
        {
          id: `comment_${threadId}`,
          threadId,
          artifactId: id,
          createdAt: time,
          context: artifactReferenceContext(structuredClone(target)),
          target: null,
          author: human,
          body: body,
          attachments: attachments,
          sentAt: null,
          legacy: null,
        },
      ],
    };
    this.get(id).threads.push(note);
    this.state.everDelivered[note.id] = false;
    this.changed(id);
    return structuredClone(note);
  }
  artifactComments(id: string): ArtifactComment[] {
    return this.get(id).events.flatMap((event) => (event.comment ? [event.comment] : []));
  }
  pendingComments(id: string) {
    return this.artifactComments(id).filter(
      (comment) => comment.author.role === "human" && comment.sentAt === null,
    );
  }
  pending(id: string) {
    return this.get(id).threads.filter(hasUnsentArtifactThread);
  }
  async snapshot(id: string, only?: string[]): Promise<ArtifactCommentSnapshot> {
    const artifact = this.get(id);
    if (artifact.state !== "active") fail("Artifact is archived", 409);
    const threads = only ? [...new Set(only)].sort() : undefined;
    const selected = this.pending(id).filter((note) => !threads || threads.includes(note.id));
    const comments = only ? [] : this.pendingComments(id);
    const text = buildArtifactPrompt(artifact, selected, true, comments);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([id, this.state.discussionRevisions[id] ?? 0, threads ?? null]),
      ),
    );
    const expectedFingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      text,
      itemCount: selected.length + comments.length,
      attachments: commentAttachments(selected, true),
      acknowledgment: { threads, expectedFingerprint },
    };
  }
  handoff(id: string, threads?: string[]) {
    const artifact = this.get(id);
    if (artifact.state === "archived") fail("Restore the artifact before submitting comments", 409);
    const notes = this.pending(id).filter((note) => !threads || threads.includes(note.id));
    const time = now();
    for (const note of notes) {
      this.state.everDelivered[note.id] = true;
      if (note.comments[0]!.author.role === "human") note.comments[0]!.sentAt = time;
      note.statusUnsent = false;
      for (const comment of note.comments.slice(1))
        if (comment.author.role === "human") comment.sentAt = time;
    }
    if (!threads) for (const comment of this.pendingComments(id)) comment.sentAt = time;
    this.changed(id);
    if (notes.length)
      this.runAgent(
        id,
        notes.map((note) => note.id),
      );
  }
  private runAgent(id: string, ids: string[]) {
    const artifact = this.get(id);
    artifact.watching = false;
    const time = now();
    for (const note of artifact.threads)
      if (ids.includes(note.id) && note.status === "open")
        note.claim = {
          threadId: note.id,
          sessionId: actor.sessionId,
          claimedAt: time,
          renewedAt: time,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
    artifact.working = artifact.threads.some((note) => note.claim !== null);
    this.changed(id);
    // Each explicit handoff schedules its own response, so a second submission
    // cannot cancel the first batch. Archive closes all further conversation writes.
    const key = mint("work");
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const current = this.state.artifacts.find((item) => item.id === id);
        if (!current || current.state !== "active") return;
        const pending = this.state.pending[id];
        if (pending && current.state === "active") {
          const publication = structuredClone(pending);
          publication.version.createdAt = publication.version.publishedAt = now();
          this.state.publications[publicationKey(id, publication.version.seq)] = publication;
          current.versions.push(publication.version);
          current.nextSeq = publication.version.seq + 1;
          delete this.state.pending[id];
        }
        const latest = current.versions.at(-1)!;
        for (const note of current.threads)
          if (ids.includes(note.id)) {
            note.comments.push({
              id: mint("comment"),
              artifactId: id,
              threadId: note.id,
              author: actor,
              body: `This is a scripted demo comment. I reviewed your note${pending && current.state === "active" ? ` and published version ${latest.seq}` : ""}. You can keep reading the original version, inspect the publication, and resolve the thread when you are satisfied.`,
              context: {
                versionSeq: latest.seq,
                representation:
                  current.kind === "diff"
                    ? "diff"
                    : current.kind === "html" || note.target.kind === "rendered"
                      ? "rendered"
                      : "source",
              },
              target: null,
              legacy: null,
              createdAt: now(),
              sentAt: now(),
            });
            note.claim = null;
          }
        current.working = current.threads.some((note) => note.claim !== null);
        if (current.state === "active" && !current.working) current.watching = true;
        this.changed(id, { type: "version-published", artifactId: id, seq: latest.seq });
      }, 1800),
    );
  }
  lifecycle(id: string, body: Omit<ArtifactLifecycleBody, "actor">): ArtifactLifecycleResponse {
    const artifact = this.get(id);
    const message = body.comment?.body.trim() || null;
    if (body.event === "restored" && message) fail("Only archive accepts a Comment");
    const previous = artifact.events.find((event) => event.operationKey === body.operationKey);
    if (previous) {
      if (
        previous.event !== body.event ||
        (this.state.lifecycleRequests?.[previous.id] ?? previous.comment?.body ?? null) !== message
      )
        fail("Operation key was used for another transition", 409);
      return {
        event: structuredClone(previous),
        replayed: true,
        notification: { state: "not_repeated" },
      };
    }
    const state = body.event === "archived" ? "archived" : "active";
    if (artifact.state === state) fail("Artifact is already in that state", 409);
    const event: ArtifactLifecycleEvent = {
      id: mint("event"),
      artifactId: id,
      seq: artifact.events.length + 1,
      actor: human,
      event: body.event,
      comment: message
        ? {
            id: mint("comment"),
            artifactId: id,
            threadId: null,
            author: human,
            context: { versionSeq: null, representation: null },
            target: null,
            legacy: null,
            createdAt: now(),
            sentAt: null,
            body: message,
          }
        : null,
      operationKey: body.operationKey,
      createdAt: now(),
    };
    const notify = artifact.watching && message !== null && state === "archived";
    artifact.state = state;
    artifact.archivedAt = state === "archived" ? event.createdAt : null;
    artifact.events.push(event);
    this.state.lifecycleRequests ??= {};
    this.state.lifecycleRequests[event.id] = message;
    if (notify && event.comment && event.comment.body.length <= 8000)
      event.comment.sentAt = event.createdAt;
    artifact.watching = false;
    artifact.working = false;
    for (const note of artifact.threads) note.claim = null;
    this.changed(id, { type: "lifecycle", artifactId: id, event });
    return {
      event: structuredClone(event),
      replayed: false,
      notification: { state: notify ? "sent" : "none" },
    };
  }
}
export const demo = new ArtifactDemoBackend();
