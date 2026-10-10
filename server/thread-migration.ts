import type { Database } from "bun:sqlite";

// Schema 14 called resolvable topics discussions. The artifact's overall
// discussion keeps its revision; thread and comment identities remain opaque.
export function renameThreads(db: Database): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discussions'").get())
    return;
  // Derived search categories and serialized locations use the public names.
  // Rebuild them instead of rewriting captured content or arbitrary JSON.
  db.exec(`DROP TRIGGER IF EXISTS search_document_insert;
    DROP TRIGGER IF EXISTS search_document_delete;
    DROP TRIGGER IF EXISTS search_document_update;
    DROP TABLE IF EXISTS artifact_search_fts;
    DROP TABLE IF EXISTS artifact_search_documents;
    DROP TABLE IF EXISTS artifact_search_versions;`);
  for (const [before, after] of [
    ["discussions", "threads"],
    ["discussion_claims", "thread_claims"],
    ["discussion_placements", "thread_placements"],
  ])
    db.exec(`ALTER TABLE ${before} RENAME TO ${after}`);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const { name } of db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()) {
    if (
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${quote(name)})`)
        .all()
        .some((column) => column.name === "discussion_id")
    )
      db.exec(`ALTER TABLE ${quote(name)} RENAME COLUMN discussion_id TO thread_id`);
  }
  // SQLite updates references, but leaves index and trigger names unchanged.
  for (const object of db
    .query<{ name: string; type: string; sql: string }, []>(
      "SELECT name,type,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all()) {
    const next = object.name
      .replaceAll("discussions", "threads")
      .replaceAll("discussion", "thread");
    if (next === object.name) continue;
    db.exec(`DROP ${object.type} ${quote(object.name)}`);
    db.exec(object.sql.replace(object.name, next));
  }
}
