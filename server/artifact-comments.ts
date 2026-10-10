import type { Database } from "bun:sqlite";
import type { ArtifactActor, ArtifactComment } from "../shared/artifacts.ts";

// Archive creates an artifact-level Comment in its transition transaction.
// It has no Thread status or native target; edits still require active.
export const ARTIFACT_COMMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK(author IN ('human','agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  CHECK ((author='human' AND agent_session_id IS NULL) OR
    (author='agent' AND agent_session_id IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS artifact_comments_by_artifact ON artifact_comments(artifact_id,created_at);
`;

type Row = {
  id: string;
  artifact_id: string;
  author: "human" | "agent";
  agent_session_id: string | null;
  body: string;
  created_at: string;
  sent_at: string | null;
};

export function artifactComment(db: Database, id: string): ArtifactComment | null {
  const row = db.query<Row, [string]>("SELECT * FROM artifact_comments WHERE id=?").get(id);
  return row
    ? {
        id: row.id,
        artifactId: row.artifact_id,
        threadId: null,
        author:
          row.author === "human"
            ? { role: "human", sessionId: null }
            : { role: "agent", sessionId: row.agent_session_id! },
        body: row.body,
        context: { versionSeq: null, representation: null },
        target: null,
        attachments: [],
        legacy: null,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      }
    : null;
}

export function createArtifactComment(
  db: Database,
  id: string,
  artifactId: string,
  actor: ArtifactActor,
  body: string,
  time: string,
): ArtifactComment {
  db.query(`INSERT INTO artifact_comments(id,artifact_id,author,agent_session_id,body,created_at,sent_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    id,
    artifactId,
    actor.role,
    actor.sessionId,
    body,
    time,
    actor.role === "agent" ? time : null,
  );
  return artifactComment(db, id)!;
}

export function artifactComments(db: Database, id: string): ArtifactComment[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM artifact_comments WHERE artifact_id=? ORDER BY created_at,rowid",
    )
    .all(id)
    .map(({ id }) => artifactComment(db, id)!);
}

export function upgradeArtifactComments(db: Database, time: string): void {
  db.exec(ARTIFACT_COMMENT_SCHEMA);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(artifact_events)").all();
  if (columns.some((column) => column.name === "comment_id")) return;
  db.exec(
    "ALTER TABLE artifact_events ADD COLUMN comment_id TEXT REFERENCES artifact_comments(id)",
  );
  // The original body remains immutable request evidence for operation replay.
  // The referenced Comment is the message users read and edit. Old human
  // archive delivery is unknown; never manufacture a delivery timestamp.
  db.exec(`DROP TRIGGER artifact_event_is_immutable;
    INSERT INTO artifact_comments(id,artifact_id,author,agent_session_id,body,created_at,sent_at)
      SELECT 'comment_'||id,artifact_id,actor,agent_session_id,message,created_at,
        CASE WHEN actor='agent' THEN created_at ELSE NULL END
      FROM artifact_events WHERE message IS NOT NULL;
    UPDATE artifact_events SET comment_id='comment_'||id WHERE message IS NOT NULL;
    CREATE TRIGGER artifact_event_is_immutable BEFORE UPDATE ON artifact_events BEGIN
      SELECT RAISE(ABORT, 'artifact lifecycle history is immutable'); END;`);
  if (
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_activity'").get()
  ) {
    db.exec(`INSERT INTO artifact_activity SELECT occurred_at,'commentsAdded',count FROM artifact_activity WHERE metric='threadsAdded'
      ON CONFLICT(occurred_at,metric) DO UPDATE SET count=count+excluded.count;
      INSERT INTO artifact_activity SELECT created_at,'commentsAdded',count(*) FROM artifact_comments GROUP BY created_at
      ON CONFLICT(occurred_at,metric) DO UPDATE SET count=count+excluded.count;`);
    // Already-deleted archive notes cannot be reconstructed as Comment activity.
    db.query("UPDATE artifact_activity_coverage SET complete_since=? WHERE id=1").run(time);
  }
}
