import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ArtifactActor, ArtifactWatcher } from "../shared/artifacts.ts";
import type { ListenerTarget } from "../shared/types.ts";
import { nowIso } from "./ids.ts";

export const ARTIFACT_LISTENER_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_agent_targets (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  target_json TEXT NOT NULL CHECK (json_valid(target_json))
) STRICT;
CREATE TABLE IF NOT EXISTS artifact_listeners (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('fallback', 'explicit')),
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES local_agent_targets(session_id) ON DELETE CASCADE,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, mode)
) STRICT;
`;

export interface StoredArtifactListener {
  info: ArtifactWatcher;
  target: ListenerTarget;
}

// Local delivery credentials never appear in public session or artifact reads.
// All mutations use the daemon's injected connection, including publication and
// archive transactions. A transport adapter can later relay from a remote store.
export class ArtifactListeners {
  constructor(
    private readonly db: Database,
    private readonly clock = nowIso,
  ) {}

  setTarget(sessionId: string, target: ListenerTarget | null): void {
    if (target === null) {
      this.db.query("DELETE FROM local_agent_targets WHERE session_id = ?").run(sessionId);
      return;
    }
    this.db
      .query(`INSERT INTO local_agent_targets(session_id, target_json) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET target_json = excluded.target_json`)
      .run(sessionId, JSON.stringify(target));
  }

  register(id: string, actor: ArtifactActor, mode: "fallback" | "explicit"): boolean {
    if (actor.role !== "agent") return false;
    const changed = this.db
      .query(`INSERT INTO artifact_listeners
      (artifact_id, mode, id, session_id, registered_at)
      SELECT ?, ?, ?, session_id, ? FROM local_agent_targets WHERE session_id = ?
      ON CONFLICT(artifact_id, mode) DO UPDATE SET id = excluded.id,
        session_id = excluded.session_id, registered_at = excluded.registered_at`)
      .run(id, mode, randomUUID(), this.clock(), actor.sessionId);
    return changed.changes > 0;
  }

  published(id: string, actor: ArtifactActor, enabled: boolean): void {
    this.db
      .query("DELETE FROM artifact_listeners WHERE artifact_id = ? AND mode = 'fallback'")
      .run(id);
    if (enabled) this.register(id, actor, "fallback");
  }

  selected(id: string): StoredArtifactListener | undefined {
    const row = this.db
      .query<
        {
          id: string;
          mode: "fallback" | "explicit";
          sessionId: string;
          registeredAt: string;
          label: string | null;
          target: string;
        },
        [string]
      >(`SELECT l.id, l.mode, l.session_id AS sessionId,
      l.registered_at AS registeredAt, s.label, t.target_json AS target
      FROM artifact_listeners l JOIN local_agent_targets t ON t.session_id = l.session_id
      JOIN agent_sessions s ON s.id = l.session_id
      WHERE l.artifact_id = ? ORDER BY CASE l.mode WHEN 'explicit' THEN 0 ELSE 1 END LIMIT 1`)
      .get(id);
    if (!row) return undefined;
    return {
      info: {
        id: row.id,
        kind: "listen",
        mode: row.mode,
        label: row.label,
        actor: { role: "agent", sessionId: row.sessionId },
        connectedAt: row.registeredAt,
      },
      target: JSON.parse(row.target) as ListenerTarget,
    };
  }

  clearExplicit(id: string): void {
    this.db
      .query("DELETE FROM artifact_listeners WHERE artifact_id = ? AND mode = 'explicit'")
      .run(id);
  }

  failed(registrationId: string): void {
    this.db
      .query("DELETE FROM artifact_listeners WHERE id = ? AND mode = 'explicit'")
      .run(registrationId);
  }

  remove(id: string, actor: ArtifactActor): void {
    this.db
      .query("DELETE FROM artifact_listeners WHERE artifact_id = ? AND session_id = ?")
      .run(id, actor.sessionId);
  }

  clear(id: string): void {
    this.db.query("DELETE FROM artifact_listeners WHERE artifact_id = ?").run(id);
  }
}
