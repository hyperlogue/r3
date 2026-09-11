import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../shared/artifacts.ts";
import { MigrationDefaults } from "./migration-defaults.ts";

const migrationTime = "2026-09-01T00:00:00.000Z";

describe("explicit migration defaults", () => {
  test("missing roles use the human owner and record the choice", () => {
    const sessions = new Map<string, AgentSession>();
    const defaults = new MigrationDefaults("review:legacy", migrationTime, sessions);
    expect(defaults.actor("createdBy", undefined, undefined)).toEqual({
      role: "human",
      sessionId: null,
    });
    expect(defaults.records).toHaveLength(1);
    expect(defaults.records[0]).toMatchObject({
      entity: "review:legacy",
      field: "createdBy",
      value: "human",
    });
    expect(sessions.size).toBe(0);
  });

  test("unknown agents receive stable separate sessions while a known session remains shared", () => {
    const sessions = new Map<string, AgentSession>();
    const a = new MigrationDefaults("reply:first", migrationTime, sessions);
    const b = new MigrationDefaults("reply:second", migrationTime, sessions);
    const first = a.actor("author", "agent", null);
    const second = b.actor("author", "agent", null);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(
      new MigrationDefaults("reply:first", migrationTime, sessions).actor("author", "agent", null),
    ).toEqual(first);
    expect([...sessions.values()].every((session) => session.label === "Imported agent")).toBe(
      true,
    );
    expect(a.actor("author", "agent", "known-session")).toEqual(
      b.actor("author", "agent", "known-session"),
    );
    expect(sessions.size).toBe(3);
  });

  test("valid timestamps survive, UTC normalization is explicit, and missing dates use recorded fallbacks", () => {
    const defaults = new MigrationDefaults("version:legacy:1", migrationTime, new Map());
    expect(defaults.time("createdAt", "2025-01-01T00:00:00.000Z")).toBe("2025-01-01T00:00:00.000Z");
    expect(defaults.records).toEqual([]);
    expect(defaults.time("publishedAt", "2025-01-01 00:00:00")).toBe("2025-01-01T00:00:00.000Z");
    expect(defaults.time("createdAt", null, "2025-02-01T00:00:00.000Z")).toBe(
      "2025-02-01T00:00:00.000Z",
    );
    expect(defaults.time("createdAt", "unavailable")).toBe(migrationTime);
    expect(defaults.records).toHaveLength(3);
  });
});
