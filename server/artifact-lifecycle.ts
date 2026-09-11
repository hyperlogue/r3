import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ArtifactLifecycleEvent } from "../shared/artifacts.ts";
import {
  ArtifactError,
  optionalText,
  requireObject,
  requireString,
} from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { nowIso } from "./ids.ts";

type EventRow = {
  id: string;
  seq: number;
  artifact_id: string;
  event: "archived" | "restored";
  operation_key: string;
  actor: "human" | "agent";
  agent_session_id: string | null;
  message: string | null;
  created_at: string;
};

function eventFromRow(row: EventRow): ArtifactLifecycleEvent {
  return {
    id: row.id,
    seq: row.seq,
    artifactId: row.artifact_id,
    event: row.event,
    operationKey: row.operation_key,
    actor:
      row.actor === "human"
        ? { role: "human", sessionId: null }
        : { role: "agent", sessionId: row.agent_session_id! },
    message: row.message,
    createdAt: row.created_at,
  };
}

// The collaboration boundary captures/drops its listener around this synchronous
// transition, then broadcasts and optionally pushes after commit. `replayed`
// prevents a retry from delivering the ordinary notification a second time.
export class ArtifactLifecycle {
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
    private readonly clock: () => string = nowIso,
  ) {}

  events(id: string): ArtifactLifecycleEvent[] {
    this.artifacts.get(id);
    return this.db
      .query<EventRow, [string]>("SELECT * FROM artifact_events WHERE artifact_id = ? ORDER BY seq")
      .all(id)
      .map(eventFromRow);
  }

  transition(id: string, value: unknown): { event: ArtifactLifecycleEvent; replayed: boolean } {
    const input = requireObject(value, "Lifecycle transition");
    const actor = this.artifacts.validateActor(input.actor);
    const operationKey = requireString(input.operationKey, "operationKey", 200);
    if (input.event !== "archived" && input.event !== "restored")
      throw new ArtifactError("Lifecycle event must be archived or restored");
    const event = input.event;
    const message = optionalText(input.message, "Archive message")?.trim() || null;
    if (event === "restored" && message !== null)
      throw new ArtifactError("Only archive accepts a message");
    return this.db
      .transaction(() => {
        const artifact = this.artifacts.get(id);
        const previous = this.db
          .query<EventRow, [string, string]>(
            "SELECT * FROM artifact_events WHERE artifact_id = ? AND operation_key = ?",
          )
          .get(id, operationKey);
        if (previous) {
          if (
            previous.event !== event ||
            previous.message !== message ||
            previous.actor !== actor.role ||
            previous.agent_session_id !== actor.sessionId
          ) {
            throw new ArtifactError(
              "Lifecycle operation key was already used for a different transition",
              409,
            );
          }
          return { event: eventFromRow(previous), replayed: true };
        }
        const state = event === "archived" ? "archived" : "active";
        if (artifact.state === state) throw new ArtifactError(`Artifact is already ${state}`, 409);
        const time = this.clock();
        const eventId = `event_${randomUUID().replaceAll("-", "")}`;
        this.db
          .query("UPDATE artifacts SET state = ?, archived_at = ?, updated_at = ? WHERE id = ?")
          .run(state, state === "archived" ? time : null, time, id);
        this.db
          .query(`INSERT INTO artifact_events(id, artifact_id, event, operation_key, actor, agent_session_id, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(eventId, id, event, operationKey, actor.role, actor.sessionId, message, time);
        if (state === "archived") {
          this.db
            .query(
              "DELETE FROM feedback_claims WHERE feedback_id IN (SELECT id FROM feedback WHERE artifact_id = ?)",
            )
            .run(id);
        }
        const stored = this.db
          .query<EventRow, [string]>("SELECT * FROM artifact_events WHERE id = ?")
          .get(eventId)!;
        return { event: eventFromRow(stored), replayed: false };
      })
      .immediate();
  }
}
