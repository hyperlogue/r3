import type { AgentSession, ArtifactActor } from "../shared/artifacts.ts";
import { hashBytes } from "./blobs.ts";

export interface MigrationDefault {
  entity: string;
  field: string;
  value: unknown;
  reason: string;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Old SQLite-style timestamps are UTC. Never let the machine's timezone
  // decide a migrated timestamp when the legacy value omitted its zone.
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// One scope per imported entity. The caller persists `records` with that
// entity's legacy evidence/provenance and writes the shared session registry.
// Normal request handlers never use these migration-only fallbacks.
export class MigrationDefaults {
  readonly records: MigrationDefault[] = [];

  constructor(
    private readonly entity: string,
    private readonly migrationTime: string,
    private readonly sessions: Map<string, AgentSession>,
  ) {}

  record(field: string, value: unknown, reason: string): void {
    this.records.push({ entity: this.entity, field, value, reason });
  }

  time(field: string, value: unknown, fallback?: unknown): string {
    const original = timestamp(value);
    if (original !== null) {
      if (original !== value)
        this.record(field, original, "Normalized the retained timestamp to UTC");
      return original;
    }
    const inherited = timestamp(fallback);
    const chosen = inherited ?? this.migrationTime;
    this.record(
      field,
      chosen,
      inherited === null
        ? "No valid legacy timestamp; used migration time"
        : "Missing or invalid timestamp; used related legacy timestamp",
    );
    return chosen;
  }

  actor(
    field: string,
    role: unknown,
    sessionId: unknown,
    createdAt = this.migrationTime,
  ): ArtifactActor {
    if (role !== "agent") {
      if (role !== "human")
        this.record(field, "human", "No known legacy role; attributed to the human owner");
      return { role: "human", sessionId: null };
    }
    const knownSession = typeof sessionId === "string" && sessionId.trim() !== "";
    const id = knownSession ? sessionId : `imported_${hashBytes(this.entity).slice(0, 32)}`;
    if (!knownSession) {
      this.record(
        `${field}.sessionId`,
        id,
        "Agent role was known but its session was absent; created an entity-specific imported session",
      );
    }
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        id,
        harness: null,
        label: knownSession ? null : "Imported agent",
        createdAt,
      });
    }
    return { role: "agent", sessionId: id };
  }
}
