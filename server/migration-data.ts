import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { AgentSession } from "../shared/artifacts.ts";
import { MigrationDefaults } from "./migration-defaults.ts";

export const LEGACY_TABLES = [
  "repos",
  "reviews",
  "patches",
  "snapshots",
  "snapshot_files",
  "feedback",
  "replies",
  "feedback_claims",
  "viewed_marks",
  "auth_tokens",
  "auth_sessions",
] as const;
export type LegacyTable = (typeof LEGACY_TABLES)[number];
export type LegacyRow = Record<string, SQLQueryBindings>;
export type LegacyData = Record<LegacyTable, LegacyRow[]>;

export function sqlName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function readLegacyData(db: Database): LegacyData {
  const names = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (!names.has("reviews")) throw new Error("No legacy review store to migrate");
  return Object.fromEntries(
    LEGACY_TABLES.map((name) => [
      name,
      names.has(name) ? db.query<LegacyRow, []>(`SELECT * FROM ${sqlName(name)}`).all() : [],
    ]),
  ) as LegacyData;
}

export function legacyText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function legacyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function legacyId(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new Error("Legacy record has no ID");
  return value;
}

export function legacySeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class MigrationContext {
  readonly sessions = new Map<string, AgentSession>();
  constructor(
    readonly db: Database,
    readonly data: LegacyData,
    readonly time: string,
  ) {}

  defaults(entity: string): MigrationDefaults {
    return new MigrationDefaults(entity, this.time, this.sessions);
  }

  writeSessions(): void {
    const insert = this.db.query(`INSERT INTO agent_sessions(id, harness, label, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
    for (const session of this.sessions.values()) {
      insert.run(session.id, session.harness, session.label, session.createdAt);
    }
  }
}
