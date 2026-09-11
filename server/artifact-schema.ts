import type { Database } from "bun:sqlite";

export const ARTIFACT_SCHEMA_VERSION = 1;

// Applied to fresh stores and to the destination of the legacy migration.
// This module never opens a database itself.
export const ARTIFACT_SCHEMA = `
-- Content bytes are stored outside SQLite, addressed by SHA-256.
-- Times are canonical UTC ISO-8601 strings supplied by the server.
-- Required attribution is explicit. Migration backfills missing values before
-- insert; the normal write path gets no implicit historical defaults.
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  remote_url TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- Attribution for a logical agent run, not a user account or a credential.
-- Concurrent agents, including subagents, register distinct session IDs.
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  harness TEXT,
  label TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('files', 'html', 'diff')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT,
  summary TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
    CHECK (CASE WHEN json_valid(meta_json) THEN json_type(meta_json) = 'object' ELSE 0 END),
  legacy_json TEXT
    CHECK (legacy_json IS NULL OR
      CASE WHEN json_valid(legacy_json) THEN json_type(legacy_json) = 'object' ELSE 0 END),
  created_by TEXT NOT NULL CHECK (created_by IN ('human', 'agent')),
  creator_session_id TEXT REFERENCES agent_sessions(id),
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (id, kind),
  CHECK ((created_by = 'human' AND creator_session_id IS NULL) OR
         (created_by = 'agent' AND creator_session_id IS NOT NULL)),
  CHECK ((state = 'active' AND archived_at IS NULL) OR
         (state = 'archived' AND archived_at IS NOT NULL))
) STRICT;

-- Archive/restore history is separate from open/resolved feedback.
-- Transport registrations and credentials remain in memory, never here.
CREATE TABLE artifact_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('archived', 'restored')),
  operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  message TEXT CHECK (message IS NULL OR length(trim(message)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, operation_key),
  CHECK ((actor = 'human' AND agent_session_id IS NULL) OR
         (actor = 'agent' AND agent_session_id IS NOT NULL)),
  CHECK (event = 'archived' OR message IS NULL)
) STRICT;

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL
) STRICT;

-- entrypoint and patch_body are mutually exclusive variant fields.
-- published_at stays NULL only while assembling a publication transaction.
CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('files', 'html', 'diff')),
  publication_key TEXT NOT NULL CHECK (length(publication_key) > 0),
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  label TEXT,
  summary TEXT,
  published_by TEXT NOT NULL CHECK (published_by IN ('human', 'agent')),
  publisher_session_id TEXT REFERENCES agent_sessions(id),
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (CASE WHEN json_valid(provenance_json) THEN json_type(provenance_json) = 'object' ELSE 0 END),
  entrypoint TEXT,
  patch_body TEXT,
  file_count INTEGER,
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (artifact_id, seq),
  UNIQUE (artifact_id, seq, kind),
  UNIQUE (artifact_id, publication_key),
  FOREIGN KEY (artifact_id, kind) REFERENCES artifacts(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, seq, entrypoint)
    REFERENCES version_files(artifact_id, version_seq, path)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (kind = 'files' AND entrypoint IS NULL AND patch_body IS NULL
      AND file_count IS NOT NULL AND file_count > 0) OR
    (kind = 'html' AND entrypoint IS NOT NULL
      AND entrypoint IN ('index.html', 'index.md') AND patch_body IS NULL
      AND file_count IS NOT NULL AND file_count > 0) OR
    (kind = 'diff' AND entrypoint IS NULL AND patch_body IS NOT NULL
      AND length(trim(patch_body)) > 0 AND file_count IS NULL)
  ),
  CHECK ((published_by = 'human' AND publisher_session_id IS NULL) OR
         (published_by = 'agent' AND publisher_session_id IS NOT NULL))
) STRICT;

CREATE TABLE version_files (
  artifact_id TEXT NOT NULL,
  version_seq INTEGER NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html')),
  path TEXT NOT NULL
    CHECK (length(path) > 0 AND substr(path, 1, 1) <> '/' AND instr(path, char(0)) = 0),
  media_type TEXT NOT NULL CHECK (length(media_type) > 0),
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  rendered_blob_hash TEXT REFERENCES blobs(hash),
  renderer_revision TEXT,
  PRIMARY KEY (artifact_id, version_seq, path),
  FOREIGN KEY (artifact_id, version_seq, artifact_kind)
    REFERENCES artifact_versions(artifact_id, seq, kind) ON DELETE CASCADE,
  CHECK ((rendered_blob_hash IS NULL AND renderer_revision IS NULL) OR
         (rendered_blob_hash IS NOT NULL AND renderer_revision IS NOT NULL))
) STRICT;

-- target_kind also identifies the representation. NULL locator = whole
-- document/summary; object locator = a native range, quote, or element selector.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  target_kind TEXT NOT NULL CHECK (target_kind IN (
    'artifact', 'artifact_summary', 'version_summary', 'source', 'rendered', 'diff'
  )),
  target_version_seq INTEGER,
  target_path TEXT CHECK (target_path IS NULL OR length(target_path) > 0),
  locator_json TEXT
    CHECK (locator_json IS NULL OR
      CASE WHEN json_valid(locator_json) THEN json_type(locator_json) = 'object' ELSE 0 END),
  legacy_anchor_json TEXT
    CHECK (legacy_anchor_json IS NULL OR
      CASE WHEN json_valid(legacy_anchor_json) THEN json_type(legacy_anchor_json) = 'object' ELSE 0 END),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  status_unsent INTEGER NOT NULL DEFAULT 0 CHECK (status_unsent IN (0, 1)),
  UNIQUE (id, artifact_id, artifact_kind),
  CHECK ((author = 'human' AND agent_session_id IS NULL) OR
         (author = 'agent' AND agent_session_id IS NOT NULL)),
  FOREIGN KEY (artifact_id, artifact_kind)
    REFERENCES artifacts(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, target_version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (target_kind = 'artifact' AND target_version_seq IS NULL
      AND target_path IS NULL AND locator_json IS NULL) OR
    (target_kind = 'artifact_summary' AND target_version_seq IS NULL AND target_path IS NULL) OR
    (target_kind = 'version_summary' AND target_version_seq IS NOT NULL AND target_path IS NULL) OR
    (target_kind IN ('source', 'rendered', 'diff')
      AND target_version_seq IS NOT NULL AND target_path IS NOT NULL)
  ),
  CHECK (
    target_kind IN ('artifact', 'artifact_summary', 'version_summary') OR
    (artifact_kind = 'files' AND target_kind IN ('source', 'rendered')) OR
    (artifact_kind = 'html' AND target_kind = 'rendered') OR
    (artifact_kind = 'diff' AND target_kind = 'diff')
  )
) STRICT;

CREATE TABLE replies (
  id TEXT PRIMARY KEY NOT NULL,
  feedback_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  body TEXT NOT NULL,
  context_version_seq INTEGER,
  context_representation TEXT CHECK (context_representation IN ('source', 'rendered', 'diff')),
  target_kind TEXT CHECK (target_kind IN ('version_summary', 'source', 'rendered', 'diff')),
  target_version_seq INTEGER,
  target_path TEXT CHECK (target_path IS NULL OR length(target_path) > 0),
  locator_json TEXT
    CHECK (locator_json IS NULL OR
      CASE WHEN json_valid(locator_json) THEN json_type(locator_json) = 'object' ELSE 0 END),
  legacy_reference_json TEXT
    CHECK (legacy_reference_json IS NULL OR
      CASE WHEN json_valid(legacy_reference_json) THEN json_type(legacy_reference_json) = 'object' ELSE 0 END),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  CHECK ((author = 'human' AND agent_session_id IS NULL) OR
         (author = 'agent' AND agent_session_id IS NOT NULL)),
  FOREIGN KEY (feedback_id, artifact_id, artifact_kind)
    REFERENCES feedback(id, artifact_id, artifact_kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, context_version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_id, target_version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (context_version_seq IS NOT NULL OR context_representation IS NULL),
  CHECK (
    context_representation IS NULL OR
    (artifact_kind = 'files' AND context_representation IN ('source', 'rendered')) OR
    (artifact_kind = 'html' AND context_representation = 'rendered') OR
    (artifact_kind = 'diff' AND context_representation = 'diff')
  ),
  CHECK (CASE
    WHEN target_kind IS NULL THEN
      target_version_seq IS NULL AND target_path IS NULL AND locator_json IS NULL
    WHEN target_kind = 'version_summary' THEN
      target_version_seq IS NOT NULL AND target_path IS NULL
    ELSE target_version_seq IS NOT NULL AND target_path IS NOT NULL
  END),
  CHECK (
    target_kind IS NULL OR target_kind = 'version_summary' OR
    (artifact_kind = 'files' AND target_kind IN ('source', 'rendered')) OR
    (artifact_kind = 'html' AND target_kind = 'rendered') OR
    (artifact_kind = 'diff' AND target_kind = 'diff')
  )
) STRICT;

-- Native original targets remain on feedback. This table is for additional
-- document placements; artifact/summary notes do not need a document placement.
CREATE TABLE feedback_placements (
  feedback_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  version_seq INTEGER NOT NULL,
  document_path TEXT NOT NULL CHECK (length(document_path) > 0),
  representation TEXT NOT NULL CHECK (representation IN ('source', 'rendered', 'diff')),
  match_state TEXT NOT NULL CHECK (match_state IN ('anchored', 'unplaced', 'ambiguous')),
  locator_json TEXT
    CHECK (locator_json IS NULL OR
      CASE WHEN json_valid(locator_json) THEN json_type(locator_json) = 'object' ELSE 0 END),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (feedback_id, version_seq, document_path, representation),
  FOREIGN KEY (feedback_id, artifact_id, artifact_kind)
    REFERENCES feedback(id, artifact_id, artifact_kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (match_state = 'anchored' OR locator_json IS NULL),
  CHECK (
    (artifact_kind = 'files' AND representation IN ('source', 'rendered')) OR
    (artifact_kind = 'html' AND representation = 'rendered') OR
    (artifact_kind = 'diff' AND representation = 'diff')
  )
) STRICT;

CREATE TABLE feedback_claims (
  feedback_id TEXT PRIMARY KEY NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  claimed_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- Keep the existing content-identity key convention; add representation to
-- keys where read progress distinguishes source and rendered views.
CREATE TABLE viewed_marks (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  PRIMARY KEY (artifact_id, key)
) STRICT;

-- Existing authentication shapes; only hashes belong in these columns.
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_id TEXT NOT NULL REFERENCES auth_tokens(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX artifacts_by_project ON artifacts(project_id);
CREATE INDEX artifacts_by_activity ON artifacts(state, updated_at DESC);
CREATE INDEX artifacts_by_session ON artifacts(json_extract(meta_json, '$.session'));
CREATE INDEX artifacts_by_creator ON artifacts(creator_session_id);
CREATE INDEX events_by_artifact ON artifact_events(artifact_id, seq);
CREATE INDEX events_by_agent ON artifact_events(agent_session_id);
CREATE INDEX versions_by_sequence
  ON artifact_versions(artifact_id, seq DESC) WHERE published_at IS NOT NULL;
CREATE INDEX versions_by_publisher ON artifact_versions(publisher_session_id);
CREATE INDEX files_by_blob ON version_files(blob_hash);
CREATE INDEX files_by_rendered_blob ON version_files(rendered_blob_hash);
CREATE INDEX feedback_by_artifact ON feedback(artifact_id, status, created_at);
CREATE INDEX feedback_by_version ON feedback(artifact_id, target_version_seq);
CREATE INDEX feedback_by_agent ON feedback(agent_session_id);
CREATE INDEX replies_by_feedback ON replies(feedback_id, created_at);
CREATE INDEX replies_by_agent ON replies(agent_session_id);
CREATE INDEX replies_by_context ON replies(artifact_id, context_version_seq);
CREATE INDEX replies_by_target ON replies(artifact_id, target_version_seq);
CREATE INDEX placements_by_version ON feedback_placements(artifact_id, version_seq);
CREATE INDEX claims_by_expiry ON feedback_claims(expires_at);
CREATE INDEX claims_by_agent ON feedback_claims(agent_session_id);
CREATE INDEX sessions_by_token ON auth_sessions(token_id);

CREATE TRIGGER artifact_kind_is_immutable
BEFORE UPDATE OF id, kind, created_by, creator_session_id ON artifacts BEGIN
  SELECT RAISE(ABORT, 'artifact identity and kind are immutable');
END;

CREATE TRIGGER artifact_event_is_immutable
BEFORE UPDATE ON artifact_events BEGIN
  SELECT RAISE(ABORT, 'artifact lifecycle history is immutable');
END;

CREATE TRIGGER retain_event_until_artifact_deletion
BEFORE DELETE ON artifact_events WHEN EXISTS (
  SELECT 1 FROM artifacts WHERE id = OLD.artifact_id
) BEGIN
  SELECT RAISE(ABORT, 'artifact lifecycle history is retained');
END;

CREATE TRIGGER version_counter_cannot_decrease
BEFORE UPDATE OF next_seq ON artifacts WHEN NEW.next_seq < OLD.next_seq BEGIN
  SELECT RAISE(ABORT, 'version sequence cannot be reused');
END;

CREATE TRIGGER version_starts_unpublished
BEFORE INSERT ON artifact_versions BEGIN
  SELECT CASE WHEN NEW.published_at IS NOT NULL
    THEN RAISE(ABORT, 'assemble then publish the version') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifacts WHERE id = NEW.artifact_id
      AND state = 'active' AND next_seq = NEW.seq + 1
  ) THEN RAISE(ABORT, 'allocate a sequence on an active artifact first') END;
END;

CREATE TRIGGER version_content_is_immutable
BEFORE UPDATE OF artifact_id, seq, kind, publication_key, content_hash,
  label, summary, published_by, publisher_session_id, provenance_json, entrypoint, patch_body, file_count, created_at
ON artifact_versions BEGIN
  SELECT RAISE(ABORT, 'version content and publication metadata are immutable');
END;

CREATE TRIGGER finalize_version
BEFORE UPDATE OF published_at ON artifact_versions BEGIN
  SELECT CASE WHEN OLD.published_at IS NOT NULL OR NEW.published_at IS NULL
    THEN RAISE(ABORT, 'a version can be published only once') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND state = 'active'
  ) THEN RAISE(ABORT, 'artifact is archived') END;
  SELECT CASE WHEN NEW.kind IN ('files', 'html') AND NEW.file_count <> (
    SELECT count(*) FROM version_files
      WHERE artifact_id = NEW.artifact_id AND version_seq = NEW.seq
  ) THEN RAISE(ABORT, 'publication file membership is incomplete') END;
  SELECT CASE WHEN NEW.kind = 'html' AND NOT EXISTS (
    SELECT 1 FROM version_files WHERE artifact_id = NEW.artifact_id
      AND version_seq = NEW.seq AND path = NEW.entrypoint
  ) THEN RAISE(ABORT, 'HTML entrypoint must be a published file') END;
END;

CREATE TRIGGER files_only_during_publication
BEFORE INSERT ON version_files WHEN EXISTS (
  SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
    AND seq = NEW.version_seq AND published_at IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'cannot add files to a published version');
END;

CREATE TRIGGER file_content_is_immutable
BEFORE UPDATE ON version_files BEGIN
  SELECT RAISE(ABORT, 'published file records are immutable');
END;

CREATE TRIGGER blob_identity_is_immutable
BEFORE UPDATE ON blobs BEGIN
  SELECT RAISE(ABORT, 'blob identity is immutable');
END;

-- Cascaded deletion is allowed only after the owning artifact is deleted.
CREATE TRIGGER retain_version_until_artifact_deletion
BEFORE DELETE ON artifact_versions WHEN EXISTS (
  SELECT 1 FROM artifacts WHERE id = OLD.artifact_id
) BEGIN
  SELECT RAISE(ABORT, 'published versions are retained until artifact deletion');
END;

CREATE TRIGGER retain_files_until_artifact_deletion
BEFORE DELETE ON version_files WHEN EXISTS (
  SELECT 1 FROM artifacts WHERE id = OLD.artifact_id
) BEGIN
  SELECT RAISE(ABORT, 'version files are retained with the artifact');
END;

CREATE TRIGGER feedback_original_target_is_immutable
BEFORE UPDATE OF artifact_id, artifact_kind, author, agent_session_id, target_kind, target_version_seq,
  target_path, locator_json, legacy_anchor_json ON feedback BEGIN
  SELECT RAISE(ABORT, 'record a placement instead of changing the original target');
END;

CREATE TRIGGER reply_references_are_immutable
BEFORE UPDATE OF feedback_id, artifact_id, artifact_kind, author, agent_session_id,
  context_version_seq, context_representation, target_kind, target_version_seq,
  target_path, locator_json, legacy_reference_json ON replies BEGIN
  SELECT RAISE(ABORT, 'reply reference context is immutable');
END;

CREATE TRIGGER feedback_references_published_content
BEFORE INSERT ON feedback WHEN NEW.target_version_seq IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.target_version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'feedback target must name a published version') END;
END;

CREATE TRIGGER reply_references_published_content
BEFORE INSERT ON replies BEGIN
  SELECT CASE WHEN NEW.context_version_seq IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.context_version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'reply context must name a published version') END;
  SELECT CASE WHEN NEW.target_version_seq IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.target_version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'reply target must name a published version') END;
END;

CREATE TRIGGER placement_references_published_content
BEFORE INSERT ON feedback_placements BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'placement must name a published version') END;
END;

CREATE TRIGGER placement_identity_is_immutable
BEFORE UPDATE OF feedback_id, artifact_id, artifact_kind, version_seq,
  document_path, representation ON feedback_placements BEGIN
  SELECT RAISE(ABORT, 'replace a placement instead of changing its identity');
END;

`;

export function createArtifactTables(db: Database): void {
  db.exec(ARTIFACT_SCHEMA);
}
