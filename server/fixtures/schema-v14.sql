-- Immutable schema-14 upgrade fixture. No user data.
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  remote_url TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE project_remotes (
  remote_key TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE
) STRICT;
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
  meta_json TEXT NOT NULL DEFAULT '{}'
    CHECK (CASE WHEN json_valid(meta_json) THEN json_type(meta_json) = 'object' ELSE 0 END),
  legacy_json TEXT
    CHECK (legacy_json IS NULL OR
      CASE WHEN json_valid(legacy_json) THEN json_type(legacy_json) = 'object' ELSE 0 END),
  created_by TEXT NOT NULL CHECK (created_by IN ('human', 'agent')),
  creator_session_id TEXT REFERENCES agent_sessions(id),
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  discussion_revision INTEGER NOT NULL DEFAULT 0 CHECK (discussion_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (id, kind),
  CHECK ((created_by = 'human' AND creator_session_id IS NULL) OR
         (created_by = 'agent' AND creator_session_id IS NOT NULL)),
  CHECK ((state = 'active' AND archived_at IS NULL) OR
         (state = 'archived' AND archived_at IS NOT NULL))
) STRICT;
CREATE TABLE artifact_comments (
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
CREATE INDEX artifact_comments_by_artifact ON artifact_comments(artifact_id,created_at);
CREATE TABLE artifact_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('archived', 'restored')),
  operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  message TEXT CHECK (message IS NULL OR length(trim(message)) > 0),
  comment_id TEXT REFERENCES artifact_comments(id),
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
CREATE TABLE discussions (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  target_kind TEXT NOT NULL CHECK (target_kind IN (
    'artifact', 'artifact_summary', 'version_summary', 'source', 'rendered', 'media', 'diff'
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
  ever_delivered INTEGER NOT NULL DEFAULT 0 CHECK (ever_delivered IN (0, 1)),
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
    (target_kind IN ('source', 'rendered', 'media', 'diff')
      AND target_version_seq IS NOT NULL AND target_path IS NOT NULL)
  ),
  CHECK (
    target_kind IN ('artifact', 'artifact_summary', 'version_summary') OR
    (artifact_kind = 'files' AND target_kind IN ('source', 'rendered', 'media')) OR
    (artifact_kind = 'html' AND target_kind = 'rendered') OR
    (artifact_kind = 'diff' AND target_kind = 'diff')
  )
) STRICT;
CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  discussion_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  body TEXT NOT NULL,
  context_version_seq INTEGER,
  context_representation TEXT CHECK (context_representation IN ('source', 'rendered', 'media', 'diff')),
  target_kind TEXT CHECK (target_kind IN ('version_summary', 'source', 'rendered', 'media', 'diff')),
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
  FOREIGN KEY (discussion_id, artifact_id, artifact_kind)
    REFERENCES discussions(id, artifact_id, artifact_kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, context_version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_id, target_version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (context_version_seq IS NOT NULL OR context_representation IS NULL),
  CHECK (
    context_representation IS NULL OR
    (artifact_kind = 'files' AND context_representation IN ('source', 'rendered', 'media')) OR
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
    (artifact_kind = 'files' AND target_kind IN ('source', 'rendered', 'media')) OR
    (artifact_kind = 'html' AND target_kind = 'rendered') OR
    (artifact_kind = 'diff' AND target_kind = 'diff')
  )
) STRICT;
CREATE TABLE discussion_placements (
  discussion_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  version_seq INTEGER NOT NULL,
  document_path TEXT NOT NULL CHECK (length(document_path) > 0),
  representation TEXT NOT NULL CHECK (representation IN ('source', 'rendered', 'media', 'diff')),
  match_state TEXT NOT NULL CHECK (match_state IN ('anchored', 'unplaced', 'ambiguous')),
  locator_json TEXT
    CHECK (locator_json IS NULL OR
      CASE WHEN json_valid(locator_json) THEN json_type(locator_json) = 'object' ELSE 0 END),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (discussion_id, version_seq, document_path, representation),
  FOREIGN KEY (discussion_id, artifact_id, artifact_kind)
    REFERENCES discussions(id, artifact_id, artifact_kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (match_state = 'anchored' OR locator_json IS NULL),
  CHECK (
    (artifact_kind = 'files' AND representation IN ('source', 'rendered', 'media')) OR
    (artifact_kind = 'html' AND representation = 'rendered') OR
    (artifact_kind = 'diff' AND representation = 'diff')
  )
) STRICT;
CREATE TABLE discussion_claims (
  discussion_id TEXT PRIMARY KEY NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  claimed_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE viewed_marks (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  PRIMARY KEY (artifact_id, key)
) STRICT;
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
CREATE INDEX discussion_by_artifact ON discussions(artifact_id, status, created_at);
CREATE INDEX discussion_by_version ON discussions(artifact_id, target_version_seq);
CREATE INDEX discussion_by_agent ON discussions(agent_session_id);
CREATE INDEX comments_by_discussions ON comments(discussion_id, created_at);
CREATE INDEX comments_by_agent ON comments(agent_session_id);
CREATE INDEX comments_by_context ON comments(artifact_id, context_version_seq);
CREATE INDEX comments_by_target ON comments(artifact_id, target_version_seq);
CREATE INDEX placements_by_version ON discussion_placements(artifact_id, version_seq);
CREATE INDEX claims_by_expiry ON discussion_claims(expires_at);
CREATE INDEX claims_by_agent ON discussion_claims(agent_session_id);
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
CREATE TRIGGER discussion_original_target_is_immutable
BEFORE UPDATE OF artifact_id, artifact_kind, author, agent_session_id, target_kind, target_version_seq,
  target_path, locator_json, legacy_anchor_json ON discussions BEGIN
  SELECT RAISE(ABORT, 'record a placement instead of changing the original target');
END;
CREATE TRIGGER comment_references_are_immutable
BEFORE UPDATE OF discussion_id, artifact_id, artifact_kind, author, agent_session_id,
  context_version_seq, context_representation, target_kind, target_version_seq,
  target_path, locator_json, legacy_reference_json ON comments BEGIN
  SELECT RAISE(ABORT, 'comment reference context is immutable');
END;
CREATE TRIGGER discussion_references_published_content
BEFORE INSERT ON discussions WHEN NEW.target_version_seq IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.target_version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'discussions target must name a published version') END;
END;
CREATE TRIGGER comment_references_published_content
BEFORE INSERT ON comments BEGIN
  SELECT CASE WHEN NEW.context_version_seq IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.context_version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'comment context must name a published version') END;
  SELECT CASE WHEN NEW.target_version_seq IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.target_version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'comment target must name a published version') END;
END;
CREATE TRIGGER placement_references_published_content
BEFORE INSERT ON discussion_placements BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_versions WHERE artifact_id = NEW.artifact_id
      AND seq = NEW.version_seq AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'placement must name a published version') END;
END;
CREATE TRIGGER placement_identity_is_immutable
BEFORE UPDATE OF discussion_id, artifact_id, artifact_kind, version_seq,
  document_path, representation ON discussion_placements BEGIN
  SELECT RAISE(ABORT, 'replace a placement instead of changing its identity');
END;
CREATE TABLE local_agent_targets (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  target_json TEXT NOT NULL CHECK (json_valid(target_json))
) STRICT;
CREATE TABLE artifact_listeners (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('fallback', 'explicit')),
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES local_agent_targets(session_id) ON DELETE CASCADE,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, mode)
) STRICT;
CREATE TABLE client_authorizations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT,
  key_hash TEXT UNIQUE, refresh_hash TEXT UNIQUE, refresh_expires INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER
) STRICT;
CREATE TABLE client_access (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES client_authorizations(id),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE client_refresh_history (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES client_authorizations(id)
) STRICT;
CREATE TABLE client_devices (
  device_hash TEXT PRIMARY KEY, user_hash TEXT NOT NULL UNIQUE, label TEXT,
  status TEXT NOT NULL, expires_at INTEGER NOT NULL, poll_at INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL, client_id TEXT, request_ip TEXT
) STRICT;
CREATE TABLE client_audit (
  id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, event TEXT NOT NULL,
  at INTEGER NOT NULL, request_ip TEXT, browser_ip TEXT, worker_ip TEXT
) STRICT;
CREATE TABLE worker_registrations (
  id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, principal TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(json_valid(body)), state TEXT NOT NULL CHECK(state IN ('active','disconnected','retired'))
) STRICT;
CREATE UNIQUE INDEX discussion_attachment_owner ON discussions(id, artifact_id);
CREATE UNIQUE INDEX comment_attachment_owner ON comments(id, artifact_id);
CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  discussion_id TEXT,
  comment_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'message' CHECK (purpose IN ('message', 'target')),
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 4),
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0 AND width * height <= 20000000),
  capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
  CHECK ((discussion_id IS NULL) != (comment_id IS NULL)),
  FOREIGN KEY (discussion_id, artifact_id) REFERENCES discussions(id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id, artifact_id) REFERENCES comments(id, artifact_id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER immutable_message_attachment
BEFORE UPDATE OF id, artifact_id, discussion_id, comment_id, blob_hash, media_type, width, height, capture_json, purpose
ON message_attachments BEGIN SELECT RAISE(ABORT, 'Attachment evidence is immutable'); END;
CREATE UNIQUE INDEX target_frame_discussions ON message_attachments(discussion_id) WHERE purpose = 'target';
CREATE UNIQUE INDEX target_frame_comment ON message_attachments(comment_id) WHERE purpose = 'target';
CREATE INDEX attachments_discussions ON message_attachments(discussion_id);
CREATE INDEX attachments_comment ON message_attachments(comment_id);
CREATE TABLE message_operations (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  discussion_id TEXT,
  comment_id TEXT,
  PRIMARY KEY (artifact_id, operation_key),
  CHECK ((discussion_id IS NULL) != (comment_id IS NULL)),
  FOREIGN KEY (discussion_id, artifact_id) REFERENCES discussions(id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id, artifact_id) REFERENCES comments(id, artifact_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE artifact_search_versions (
  artifact_id TEXT NOT NULL,
  version_seq INTEGER NOT NULL,
  skipped_files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_id, version_seq),
  FOREIGN KEY (artifact_id, version_seq) REFERENCES artifact_versions(artifact_id, seq) ON DELETE CASCADE
) STRICT;
CREATE TABLE artifact_search_documents (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_seq INTEGER,
  discussion_id TEXT REFERENCES discussions(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('artifact','summary','content','discussions','comment')),
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  location_json TEXT NOT NULL,
  FOREIGN KEY (artifact_id, version_seq) REFERENCES artifact_versions(artifact_id, seq) ON DELETE CASCADE
) STRICT;
CREATE INDEX search_documents_by_version ON artifact_search_documents(artifact_id, version_seq);
CREATE VIRTUAL TABLE artifact_search_fts USING fts5(
  name, body, content='artifact_search_documents', content_rowid='id',
  tokenize='unicode61 remove_diacritics 0'
);
CREATE TRIGGER search_document_insert AFTER INSERT ON artifact_search_documents BEGIN
  INSERT INTO artifact_search_fts(rowid, name, body) VALUES (new.id, new.name, new.body);
END;
CREATE TRIGGER search_document_delete AFTER DELETE ON artifact_search_documents BEGIN
  INSERT INTO artifact_search_fts(artifact_search_fts, rowid, name, body) VALUES ('delete', old.id, old.name, old.body);
END;
CREATE TRIGGER search_document_update AFTER UPDATE ON artifact_search_documents BEGIN
  INSERT INTO artifact_search_fts(artifact_search_fts, rowid, name, body) VALUES ('delete', old.id, old.name, old.body);
  INSERT INTO artifact_search_fts(rowid, name, body) VALUES (new.id, new.name, new.body);
END;
CREATE TABLE artifact_activity (
    occurred_at TEXT NOT NULL,
    metric TEXT NOT NULL CHECK (metric IN ('artifactsCreated','versionsPublished','threadsAdded','commentsAdded','archived','restored')),
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (occurred_at, metric)
  ) STRICT;
CREATE TABLE artifact_activity_coverage (
    id INTEGER PRIMARY KEY CHECK (id = 1), complete_since TEXT
  ) STRICT;
CREATE TRIGGER activity_artifact AFTER INSERT ON artifacts  BEGIN INSERT INTO artifact_activity VALUES (NEW.created_at, 'artifactsCreated', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_publication AFTER INSERT ON artifact_versions WHEN NEW.published_at IS NOT NULL BEGIN INSERT INTO artifact_activity VALUES (NEW.published_at, 'versionsPublished', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_thread AFTER INSERT ON discussions  BEGIN INSERT INTO artifact_activity VALUES (NEW.created_at, 'threadsAdded', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_opening_comment AFTER INSERT ON discussions  BEGIN INSERT INTO artifact_activity VALUES (NEW.created_at, 'commentsAdded', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_artifact_comment AFTER INSERT ON artifact_comments  BEGIN INSERT INTO artifact_activity VALUES (NEW.created_at, 'commentsAdded', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_comment AFTER INSERT ON comments  BEGIN INSERT INTO artifact_activity VALUES (NEW.created_at, 'commentsAdded', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_lifecycle AFTER INSERT ON artifact_events  BEGIN INSERT INTO artifact_activity VALUES (NEW.created_at, NEW.event, 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
CREATE TRIGGER activity_publication_commit AFTER UPDATE OF published_at ON artifact_versions
    WHEN OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
    BEGIN INSERT INTO artifact_activity VALUES (NEW.published_at, 'versionsPublished', 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1; END;
PRAGMA user_version=14;
