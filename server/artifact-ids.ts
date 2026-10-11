import type { Database } from "bun:sqlite";
import { ArtifactError } from "./artifact-validation.ts";

export const ARTIFACT_ID_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_id_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_value TEXT NOT NULL
    CHECK (length(last_value) = 16 AND last_value NOT GLOB '*[^0-9a-f]*')
) STRICT;
INSERT INTO artifact_id_state(singleton, last_value)
  SELECT 1, COALESCE(MAX(substr(id, 10)), '0000000000000000') FROM artifacts
  WHERE length(id) = 25 AND substr(id, 1, 9) = 'artifact_'
    AND substr(id, 10) NOT GLOB '*[^0-9a-f]*'
  ON CONFLICT(singleton) DO UPDATE SET last_value = MAX(last_value, excluded.last_value);
`;

// Called inside the artifact creation write transaction. The durable high-water
// mark survives deletion and restart; no process-local allocator can reuse IDs.
export function allocateArtifactId(db: Database, time: string): string {
  const milliseconds = Date.parse(time);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds >= 2 ** 48)
    throw new ArtifactError("Artifact creation time is outside the supported ID range", 503);
  const previous = db
    .query<{ last_value: string }, []>(
      "SELECT last_value FROM artifact_id_state WHERE singleton = 1",
    )
    .get()!;
  const last = BigInt(`0x${previous.last_value}`);
  const timestamp = BigInt(milliseconds) << 16n;
  // Increment through same-millisecond writes and clock rollback. Counter
  // overflow carries into the logical millisecond rather than wrapping.
  const next = timestamp > last ? timestamp : last + 1n;
  if (next > 0xffffffffffffffffn) throw new ArtifactError("Artifact ID space is exhausted", 503);
  const value = next.toString(16).padStart(16, "0");
  db.query("UPDATE artifact_id_state SET last_value = ? WHERE singleton = 1").run(value);
  return `artifact_${value}`;
}
