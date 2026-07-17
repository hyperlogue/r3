// The in-browser store's row shapes. A demo review is fully self-contained: its
// diff rounds and snapshot diffs are stored ALREADY RENDERED (Shiki HTML baked in
// at build time — see scripts/gen-demo-fixtures.ts), so the browser never runs a
// highlighter. Live file text is kept alongside (fileContents) so the pure
// re-anchor + textdiff logic can run against real content.

import type {
  DiffFileChange,
  Feedback,
  RenderedFile,
  Reply,
  RepoRecord,
  Review,
  ThemeOption,
  ThemeStyle,
} from "../../shared/types.ts";

// A stored diff round: the parsed+highlighted file changes (not raw diff text —
// the demo never parses a unified diff at runtime; it reads these rows directly).
export interface StoredPatch {
  review_id: string;
  seq: number;
  label: string | null;
  summary: string | null;
  created_at: string;
  files: DiffFileChange[];
}

// A files-review content snapshot: every member file's full text at capture time.
export interface StoredSnapshot {
  review_id: string;
  seq: number;
  label: string | null;
  created_at: string;
  files: string[];
  contents: Record<string, string>;
}

// A pre-rendered file (kind:'files' blob view), keyed by review + ref + path.
export interface StoredBlob {
  review_id: string;
  ref: string;
  path: string;
  rendered: RenderedFile;
}

// A pre-rendered snapshot-vs-snapshot (or snapshot-vs-live) derived diff. The
// backend serves this verbatim when it matches; a diff involving edited live
// content falls back to an in-browser (uncoloured) derivation via textdiff.
export interface StoredSnapshotDiff {
  review_id: string;
  from: number;
  to: number | "WORKING";
  files: DiffFileChange[];
}

// Everything a fresh demo starts from — produced at build time and imported by
// the store. Cloned on seed/reset so mutations never touch the frozen fixture.
export interface DemoSeed {
  repo: RepoRecord;
  reviews: Review[];
  feedback: Feedback[];
  replies: Reply[];
  patches: StoredPatch[];
  snapshots: StoredSnapshot[];
  blobs: StoredBlob[];
  snapshotDiffs: StoredSnapshotDiff[];
  // reviewId -> path -> live file text (files reviews); the anchor/textdiff source.
  fileContents: Record<string, Record<string, string>>;
  // Rounds the scripted agent appends on the first hand-off, to demo a new round
  // (and an "↳ addressed in diff N" pinned reply) arriving live over the event bus.
  pendingRounds: StoredPatch[];
  themes: ThemeOption[];
  themeStyles: Record<string, ThemeStyle>;
}

// The persisted state: the seed plus per-reviewer read progress and a version
// stamp (a bump invalidates an older browser's stored copy back to the seed).
export interface DemoState extends DemoSeed {
  version: number;
  viewed: Record<string, string[]>;
}
