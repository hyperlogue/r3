export const ARTIFACT_ANCHOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_anchors (
  thread_id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('files', 'html', 'diff')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('source', 'rendered', 'media', 'diff')),
  target_version_seq INTEGER NOT NULL CHECK (target_version_seq > 0),
  target_path TEXT NOT NULL CHECK (length(target_path) > 0),
  locator_json TEXT CHECK (locator_json IS NULL OR
    CASE WHEN json_valid(locator_json) THEN json_type(locator_json) = 'object' ELSE 0 END),
  author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (thread_id, artifact_id, revision),
  FOREIGN KEY (thread_id, artifact_id, artifact_kind)
    REFERENCES threads(id, artifact_id, artifact_kind) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, target_version_seq)
    REFERENCES artifact_versions(artifact_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((author = 'human' AND agent_session_id IS NULL) OR
    (author = 'agent' AND agent_session_id IS NOT NULL)),
  CHECK (target_kind != 'media' OR locator_json IS NOT NULL),
  CHECK (
    (artifact_kind = 'files' AND target_kind IN ('source', 'rendered', 'media')) OR
    (artifact_kind = 'html' AND target_kind = 'rendered') OR
    (artifact_kind = 'diff' AND target_kind = 'diff')
  )
) STRICT;

CREATE INDEX IF NOT EXISTS thread_anchors_by_version
  ON thread_anchors(artifact_id, target_version_seq);
CREATE INDEX IF NOT EXISTS thread_anchors_by_actor
  ON thread_anchors(agent_session_id);

CREATE TRIGGER IF NOT EXISTS thread_anchor_identity_is_immutable
BEFORE UPDATE OF thread_id, artifact_id, artifact_kind, created_at ON thread_anchors
BEGIN
  SELECT RAISE(ABORT, 'Anchor identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS thread_anchor_revision_advances
BEFORE UPDATE ON thread_anchors WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'Changed anchor must increment its revision');
END;

CREATE TRIGGER IF NOT EXISTS thread_anchor_insert_is_published
BEFORE INSERT ON thread_anchors
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_versions
    WHERE artifact_id = NEW.artifact_id AND seq = NEW.target_version_seq
      AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'Anchor must name a published version') END;
END;

CREATE TRIGGER IF NOT EXISTS thread_anchor_update_is_published
BEFORE UPDATE OF target_version_seq ON thread_anchors
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_versions
    WHERE artifact_id = NEW.artifact_id AND seq = NEW.target_version_seq
      AND published_at IS NOT NULL
  ) THEN RAISE(ABORT, 'Anchor must name a published version') END;
END;

-- Media frames have independent ownership, even when their blob is shared
-- with the comment that caused the move. Delete the old frame row, update the
-- anchor revision and insert its new frame inside one transaction.
CREATE TABLE IF NOT EXISTS thread_anchor_frames (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL,
  anchor_revision INTEGER NOT NULL CHECK (anchor_revision > 0),
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0 AND width * height <= 20000000),
  capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
  FOREIGN KEY (thread_id, artifact_id, anchor_revision)
    REFERENCES thread_anchors(thread_id, artifact_id, revision)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX IF NOT EXISTS thread_anchor_frames_by_blob ON thread_anchor_frames(blob_hash);

CREATE TRIGGER IF NOT EXISTS thread_anchor_frame_is_immutable
BEFORE UPDATE ON thread_anchor_frames
BEGIN
  SELECT RAISE(ABORT, 'Anchor frame evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS thread_anchor_frame_requires_media
BEFORE INSERT ON thread_anchor_frames
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM thread_anchors WHERE thread_id = NEW.thread_id
      AND artifact_id = NEW.artifact_id AND revision = NEW.anchor_revision
      AND target_kind = 'media'
  ) THEN RAISE(ABORT, 'Anchor frame requires its media anchor') END;
END;

-- Retain idempotent outcomes, not intermediate target coordinates.
-- result_json contains only thread IDs, resulting revisions and changed flags.
-- Comment-plus-move continues to use the existing message_operations table.
CREATE TABLE IF NOT EXISTS thread_anchor_operations (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(result_json) THEN json_type(result_json) = 'array' ELSE 0 END
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, operation_key)
) STRICT;

`;
