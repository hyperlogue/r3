import type { Database } from "bun:sqlite";

// Schema 12 used these names. SQLite rewrites references when tables/columns
// move; message bytes, opaque IDs, native targets and operation hashes stay put.
export function renameConversations(db: Database): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback'").get()) return;
  // Search is a cache. Rebuild its categories and locations from the new model.
  db.exec(`DROP TRIGGER IF EXISTS search_document_insert;
    DROP TRIGGER IF EXISTS search_document_delete;
    DROP TRIGGER IF EXISTS search_document_update;
    DROP TABLE IF EXISTS artifact_search_fts;
    DROP TABLE IF EXISTS artifact_search_documents;
    DROP TABLE IF EXISTS artifact_search_versions;`);
  for (const [before, after] of [
    ["feedback", "discussions"],
    ["replies", "comments"],
    ["feedback_claims", "discussion_claims"],
    ["feedback_placements", "discussion_placements"],
  ])
    db.exec(`ALTER TABLE ${before} RENAME TO ${after}`);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const { name } of db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${quote(name)})`).all();
    for (const [before, after] of [
      ["feedback_id", "discussion_id"],
      ["reply_id", "comment_id"],
      ["feedback_revision", "discussion_revision"],
    ])
      if (columns.some((column) => column.name === before))
        db.exec(`ALTER TABLE ${quote(name)} RENAME COLUMN ${before} TO ${after}`);
  }
  // Activity history includes deleted content, so transform the counter rather
  // than reconstructing it from surviving conversations.
  if (
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_activity'").get()
  ) {
    for (const { name } of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'activity_%'",
      )
      .all())
      db.exec(`DROP TRIGGER ${quote(name)}`);
    db.exec(`ALTER TABLE artifact_activity RENAME TO conversation_activity_upgrade;
      CREATE TABLE artifact_activity (
        occurred_at TEXT NOT NULL,
        metric TEXT NOT NULL CHECK (metric IN ('artifactsCreated','versionsPublished','threadsAdded','commentsAdded','archived','restored')),
        count INTEGER NOT NULL CHECK(count > 0), PRIMARY KEY(occurred_at,metric)
      ) STRICT;
      INSERT INTO artifact_activity SELECT occurred_at,
        CASE metric WHEN 'repliesAdded' THEN 'commentsAdded' ELSE metric END, count
        FROM conversation_activity_upgrade;
      DROP TABLE conversation_activity_upgrade;`);
  }
  for (const object of db
    .query<{ name: string; type: string; sql: string }, []>(
      "SELECT name,type,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all()) {
    const next = object.name
      .replaceAll("feedback", "discussion")
      .replaceAll("replies", "comments")
      .replaceAll("reply", "comment");
    if (next === object.name) continue;
    db.exec(`DROP ${object.type} ${quote(object.name)}`);
    db.exec(object.sql.replace(object.name, next));
  }
}
