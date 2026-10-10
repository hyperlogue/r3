// Derived, rebuildable search data. Published membership and native targets
// remain authoritative. FTS stores plain text; snippets never contain HTML.
export const ARTIFACT_SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_search_versions (
  artifact_id TEXT NOT NULL,
  version_seq INTEGER NOT NULL,
  skipped_files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_id, version_seq),
  FOREIGN KEY (artifact_id, version_seq) REFERENCES artifact_versions(artifact_id, seq) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS artifact_search_documents (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_seq INTEGER,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('artifact','summary','content','thread','comment')),
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  location_json TEXT NOT NULL,
  FOREIGN KEY (artifact_id, version_seq) REFERENCES artifact_versions(artifact_id, seq) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS search_documents_by_version ON artifact_search_documents(artifact_id, version_seq);
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search_fts USING fts5(
  name, body, content='artifact_search_documents', content_rowid='id',
  tokenize='unicode61 remove_diacritics 0'
);
CREATE TRIGGER IF NOT EXISTS search_document_insert AFTER INSERT ON artifact_search_documents BEGIN
  INSERT INTO artifact_search_fts(rowid, name, body) VALUES (new.id, new.name, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_document_delete AFTER DELETE ON artifact_search_documents BEGIN
  INSERT INTO artifact_search_fts(artifact_search_fts, rowid, name, body) VALUES ('delete', old.id, old.name, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_document_update AFTER UPDATE ON artifact_search_documents BEGIN
  INSERT INTO artifact_search_fts(artifact_search_fts, rowid, name, body) VALUES ('delete', old.id, old.name, old.body);
  INSERT INTO artifact_search_fts(rowid, name, body) VALUES (new.id, new.name, new.body);
END;
`;
