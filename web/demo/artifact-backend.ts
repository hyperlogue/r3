import { ArtifactApiError } from "../../shared/artifact-client.ts";
import { buildArtifactPrompt } from "../../shared/artifact-prompt.ts";
import type {
  ArtifactFeedback,
  ArtifactFeedbackSnapshot,
  ArtifactLifecycleBody,
  ArtifactLifecycleResponse,
  ArtifactStreamEvent,
  ArtifactTarget,
} from "../../shared/artifacts.ts";
import { hasUnsentArtifactFeedback, isUnhandledArtifactFeedback } from "../../shared/artifacts.ts";
import { ARTIFACT_DEMO_SEED } from "./artifact-fixtures.gen.ts";
import { type ArtifactDemoState, demoStorageUsage, publicationKey } from "./artifact-model.ts";

const KEY = "r3-artifact-demo";
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
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null) {
    this.state = this.seed();
    try {
      const saved = JSON.parse(storage?.getItem(KEY) ?? "null");
      if ([1, 2, 3, 4].includes(saved?.schema) && Array.isArray(saved.artifacts))
        this.state = saved;
    } catch {
      /* A private or full browser store still supports this tab. */
    }
    // Add the new HTML sample once; later deletions stay deleted. Existing
    // publications and conversations survive the demo fixture upgrade.
    if (this.state.schema === 1) {
      const id = "artifact_weekend";
      if (!this.state.artifacts.some((item) => item.id === id)) {
        this.state.artifacts.push(
          structuredClone(ARTIFACT_DEMO_SEED.artifacts.find((item) => item.id === id)!),
        );
        this.state.publications[publicationKey(id, 1)] = structuredClone(
          ARTIFACT_DEMO_SEED.publications[publicationKey(id, 1)],
        );
        this.state.pending[id] = structuredClone(ARTIFACT_DEMO_SEED.pending[id]);
      }
      this.state.schema = 2;
      this.persist();
    }
    if (this.state.schema === 2) {
      // Match daemon upgrades: a cleared stamp cannot establish no prior handoff.
      this.state.everDelivered = Object.fromEntries(
        this.state.artifacts.flatMap((artifact) =>
          artifact.feedback.map((note) => [note.id, true]),
        ),
      );
      this.state.schema = 3;
      this.persist();
    }
    if (this.state.schema === 3) {
      this.state.feedbackRevisions = {};
      this.state.schema = 4;
      this.persist();
    }
    // Backfill byte metadata for saved demos without discarding their feedback.
    const seedPublications = new Map(
      [
        ...Object.values(ARTIFACT_DEMO_SEED.publications),
        ...Object.values(ARTIFACT_DEMO_SEED.pending),
      ].map((item) => [publicationKey(item.version.artifactId, item.version.seq), item]),
    );
    for (const item of [
      ...Object.values(this.state.publications),
      ...Object.values(this.state.pending),
    ]) {
      const seed = seedPublications.get(publicationKey(item.version.artifactId, item.version.seq));
      if (seed) {
        item.storageBlobs = seed.storageBlobs;
        item.patchBytes = seed.patchBytes;
      }
    }
    for (const detail of this.state.artifacts) {
      if ("summary" in detail) {
        detail.legacy = { ...detail.legacy, retiredOverview: detail.summary };
        delete detail.summary;
      }
      detail.unhandledCount = detail.feedback.filter(isUnhandledArtifactFeedback).length;
      detail.working = false;
      detail.storage = this.storageUsage(detail.id);
      for (const note of detail.feedback) note.claim = null;
    }
  }
  private seed(): ArtifactDemoState {
    const seed = structuredClone(ARTIFACT_DEMO_SEED);
    return {
      ...seed,
      schema: 4,
      feedbackRevisions: {},
      viewed: {},
      everDelivered: Object.fromEntries(
        seed.artifacts.flatMap((artifact) =>
          artifact.feedback.map((note) => [note.id, note.sentAt !== null || note.statusUnsent]),
        ),
      ),
    };
  }
  reset() {
    this.close();
    this.state = this.seed();
    this.persist();
  }
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* Keep the in-memory session. */
    }
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
    this.persist();
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
        if (rows.length !== end - start + 1 || rows.map((line) => line.text).join("\n") !== quote)
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
  addFeedback(id: string, body: string, target: ArtifactTarget): ArtifactFeedback {
    if (!body.trim()) fail("Feedback requires a message");
    this.target(id, target);
    const time = now();
    const note: ArtifactFeedback = {
      id: mint("feedback"),
      artifactId: id,
      author: human,
      body,
      status: "open",
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
    return { text, itemCount: selected.length, acknowledgment: { feedback, expectedFingerprint } };
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

const browserStorage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
export const demo = new ArtifactDemoBackend(browserStorage());
