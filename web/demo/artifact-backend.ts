import { ArtifactApiError } from "../../shared/artifact-client.ts";
import { buildArtifactPrompt, feedbackAttachments } from "../../shared/artifact-prompt.ts";
import type {
  ArtifactFeedback,
  ArtifactFeedbackSnapshot,
  ArtifactLifecycleBody,
  ArtifactLifecycleResponse,
  ArtifactSourceRange,
  ArtifactStreamEvent,
  ArtifactTarget,
} from "../../shared/artifacts.ts";
import { hasUnsentArtifactFeedback, isUnhandledArtifactFeedback } from "../../shared/artifacts.ts";
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
  readonly images = new Map<string, { artifactId: string; blob: Blob }>();
  constructor(private fixtures: ArtifactDemoSeed = ARTIFACT_DEMO_SEED) {
    this.state = this.seed();
  }
  private seed(): ArtifactDemoState {
    const seed = structuredClone(this.fixtures);
    const state: ArtifactDemoState = {
      ...seed,
      feedbackRevisions: {},
      viewed: {},
      everDelivered: Object.fromEntries(
        seed.artifacts.flatMap((artifact) =>
          artifact.feedback.map((note) => [note.id, note.sentAt !== null || note.statusUnsent]),
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
  note(id: string) {
    for (const artifact of this.state.artifacts) {
      const note = artifact.feedback.find((note) => note.id === id);
      if (note) return { artifact, note };
    }
    return fail("Feedback not found", 404);
  }
  reply(id: string) {
    for (const artifact of this.state.artifacts)
      for (const note of artifact.feedback) {
        const reply = note.replies.find((reply) => reply.id === id);
        if (reply) return { artifact, note, reply };
      }
    return fail("Reply not found", 404);
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
    this.state.feedbackRevisions[id] = (this.state.feedbackRevisions[id] ?? 0) + 1;
    artifact.unhandledCount = artifact.feedback.filter(isUnhandledArtifactFeedback).length;
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
  feedbackSource(id: string): ArtifactSourceRange {
    const { artifact, note } = this.note(id);
    const target = note.target;
    if ((target.kind !== "source" && target.kind !== "diff") || !target.locator)
      fail("Feedback has no captured source or diff line range");
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

  addFeedback(
    id: string,
    body: string,
    target: ArtifactTarget,
    attachments: ArtifactAttachment[] = [],
  ): ArtifactFeedback {
    if (!body.trim() && !attachments.length) fail("Feedback needs text or an image");
    this.target(id, target);
    const time = now();
    const note: ArtifactFeedback = {
      id: mint("feedback"),
      artifactId: id,
      author: human,
      body,
      status: "open",
      attachments,
      target: structuredClone(target),
      legacy: null,
      createdAt: time,
      updatedAt: time,
      sentAt: null,
      statusUnsent: false,
      replies: [],
      claim: null,
    };
    this.get(id).feedback.push(note);
    this.state.everDelivered[note.id] = false;
    this.changed(id);
    return structuredClone(note);
  }
  pending(id: string) {
    return this.get(id).feedback.filter(hasUnsentArtifactFeedback);
  }
  async snapshot(id: string, only?: string[]): Promise<ArtifactFeedbackSnapshot> {
    const artifact = this.get(id);
    if (artifact.state !== "active") fail("Artifact is archived", 409);
    const feedback = only ? [...new Set(only)].sort() : undefined;
    const selected = this.pending(id).filter((note) => !feedback || feedback.includes(note.id));
    const text = buildArtifactPrompt(artifact, selected, true);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([id, this.state.feedbackRevisions[id] ?? 0, feedback ?? null]),
      ),
    );
    const expectedFingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      text,
      itemCount: selected.length,
      attachments: feedbackAttachments(selected, true),
      acknowledgment: { feedback, expectedFingerprint },
    };
  }
  handoff(id: string, feedback?: string[]) {
    const artifact = this.get(id);
    if (artifact.state === "archived") fail("Restore the artifact before submitting feedback", 409);
    const notes = this.pending(id).filter((note) => !feedback || feedback.includes(note.id));
    const time = now();
    for (const note of notes) {
      this.state.everDelivered[note.id] = true;
      if (note.author.role === "human") note.sentAt = time;
      note.statusUnsent = false;
      for (const reply of note.replies) if (reply.author.role === "human") reply.sentAt = time;
    }
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
    for (const note of artifact.feedback)
      if (ids.includes(note.id) && note.status === "open")
        note.claim = {
          feedbackId: note.id,
          sessionId: actor.sessionId,
          claimedAt: time,
          renewedAt: time,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
    artifact.working = artifact.feedback.some((note) => note.claim !== null);
    this.changed(id);
    // Each explicit handoff schedules its own response, so a second submission
    // cannot cancel the first batch. Archiving still permits in-flight replies.
    const key = mint("work");
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const current = this.state.artifacts.find((item) => item.id === id);
        if (!current) return;
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
        for (const note of current.feedback)
          if (ids.includes(note.id)) {
            note.replies.push({
              id: mint("reply"),
              artifactId: id,
              feedbackId: note.id,
              author: actor,
              body: `This is a scripted demo reply. I reviewed your note${pending && current.state === "active" ? ` and published version ${latest.seq}` : ""}. You can keep reading the original version, inspect the publication, and resolve the thread when you are satisfied.`,
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
        current.working = current.feedback.some((note) => note.claim !== null);
        if (current.state === "active" && !current.working) current.watching = true;
        this.changed(id, { type: "version-published", artifactId: id, seq: latest.seq });
      }, 1800),
    );
  }
  lifecycle(id: string, body: Omit<ArtifactLifecycleBody, "actor">): ArtifactLifecycleResponse {
    const artifact = this.get(id);
    const message = body.message?.trim() ? body.message : null;
    const previous = artifact.events.find((event) => event.operationKey === body.operationKey);
    if (previous) {
      if (previous.event !== body.event || previous.message !== message)
        fail("Operation key was used for another transition", 409);
      return {
        event: structuredClone(previous),
        replayed: true,
        notification: { state: "not_repeated" },
      };
    }
    const state = body.event === "archived" ? "archived" : "active";
    if (artifact.state === state) fail("Artifact is already in that state", 409);
    const event = {
      id: mint("event"),
      artifactId: id,
      seq: artifact.events.length + 1,
      actor: human,
      event: body.event,
      message,
      operationKey: body.operationKey,
      createdAt: now(),
    };
    const notify = artifact.watching && message !== null && state === "archived";
    artifact.state = state;
    artifact.archivedAt = state === "archived" ? event.createdAt : null;
    artifact.events.push(event);
    artifact.watching = false;
    artifact.working = false;
    for (const note of artifact.feedback) note.claim = null;
    this.changed(id, { type: "lifecycle", artifactId: id, event });
    return {
      event: structuredClone(event),
      replayed: false,
      notification: { state: notify ? "sent" : "none" },
    };
  }
}

export const demo = new ArtifactDemoBackend();
