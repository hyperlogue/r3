import { randomUUID } from "node:crypto";
import type { ArtifactUpdate } from "../shared/artifact-updates.ts";
import type { ArtifactDetail, ArtifactStreamEvent } from "../shared/artifacts.ts";
import type { ArtifactCollaboration } from "./artifact-collaboration.ts";
import type { ArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError } from "./artifact-validation.ts";

// Bounded invalidations, never another persisted event log. Restart, eviction,
// metadata/publication changes and unknown cursors fall back to a full snapshot.
export class ArtifactUpdates {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly journal: { sequence: number; event: ArtifactStreamEvent }[] = [];
  readonly close: () => void;
  constructor(
    private readonly storage: ArtifactStorage,
    private readonly collaboration: ArtifactCollaboration,
    private readonly detail: (id: string) => ArtifactDetail,
    private readonly capacity = 512,
  ) {
    this.close = collaboration.subscribe((event) => {
      this.journal.push({ sequence: ++this.sequence, event });
      if (this.journal.length > this.capacity) this.journal.shift();
    });
  }
  get cursor(): string {
    return `${this.epoch}:${this.sequence}`;
  }
  snapshot(id: string): ArtifactDetail {
    return { ...this.detail(id), syncCursor: this.cursor };
  }
  read(id: string, since?: string): ArtifactUpdate {
    const [epoch, value] = since?.split(":") ?? [];
    const sequence = value && /^\d+$/.test(value) ? Number(value) : NaN;
    if (
      epoch !== this.epoch ||
      !Number.isSafeInteger(sequence) ||
      sequence > this.sequence ||
      sequence < this.sequence - this.journal.length
    )
      return this.snapshot(id);
    const events = this.journal
      .filter((entry) => entry.sequence > sequence && entry.event.artifactId === id)
      .map((entry) => entry.event);
    if (
      events.some(
        (event) =>
          !["discussions-updated", "presence-changed", "submitted", "superseded"].includes(
            event.type,
          ),
      )
    )
      return this.snapshot(id);
    const artifact = {
      ...this.storage.artifacts.get(id),
      watching: this.collaboration.watching(id),
    };
    const changed = [
      ...new Set(
        events.flatMap((event) =>
          event.type === "discussions-updated" ? [event.discussionId] : [],
        ),
      ),
    ];
    const discussions = changed.map((discussionId) => {
      try {
        return this.storage.conversations.get(discussionId);
      } catch (error) {
        if (error instanceof ArtifactError && error.status === 404) return null;
        throw error;
      }
    });
    const claims = this.storage.conversations.claims(id);
    const authors = [
      ...discussions.flatMap(
        (discussion) => discussion?.comments.map((comment) => comment.author.sessionId) ?? [],
      ),
      ...claims.map((claim) => claim.sessionId),
    ];
    return {
      delta: true,
      baseCursor: since!,
      syncCursor: this.cursor,
      artifact,
      discussions: discussions.filter((discussion) => discussion !== null),
      removedDiscussionIds: changed.filter((_, index) => discussions[index] === null),
      claims,
      watchers: this.collaboration.watchers(id),
      agentLabels: this.storage.artifacts.sessionLabels(authors.filter((id) => id !== null)),
    };
  }
}
