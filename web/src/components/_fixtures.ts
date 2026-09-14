// Shared mock data for the component stories. Built from the shared domain
// types (shared/types.ts) so the fixtures stay honest as the contract evolves.
// This is intentionally NOT a *.stories.* file, so Storybook ignores it.

import type { DiffFileChange, DiffLine, PatchDiff, ThemeOption } from "../types.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- diff (DiffView) ----

const dl = (
  type: DiffLine["type"],
  oldLine: number | null,
  newLine: number | null,
  text: string,
): DiffLine => ({ type, oldLine, newLine, text, html: esc(text) });

const diffFiles: DiffFileChange[] = [
  {
    oldPath: "server/db.ts",
    newPath: "server/db.ts",
    path: "server/db.ts",
    status: "modified",
    binary: false,
    additions: 2,
    deletions: 1,
    lines: [
      dl("hunk", null, null, "@@ -10,5 +10,6 @@ export function open(path: string) {"),
      dl("context", 10, 10, "  const db = new Database(path);"),
      dl("del", 11, null, '  db.exec("PRAGMA journal_mode = WAL");'),
      dl("add", null, 11, '  db.exec("PRAGMA journal_mode = WAL;");'),
      dl("add", null, 12, '  db.exec("PRAGMA foreign_keys = ON;");'),
      dl("context", 12, 13, "  return db;"),
      dl("context", 13, 14, "}"),
    ],
  },
  {
    oldPath: null,
    newPath: "server/ids.ts",
    path: "server/ids.ts",
    status: "added",
    binary: false,
    additions: 3,
    deletions: 0,
    lines: [
      dl("hunk", null, null, "@@ -0,0 +1,3 @@"),
      dl("add", null, 1, "export const newId = (prefix: string) =>"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text shown in the diff
      dl("add", null, 2, "  `${prefix}_${crypto.randomUUID().slice(0, 8)}`;"),
      dl("add", null, 3, ""),
    ],
  },
  {
    oldPath: null,
    newPath: "web/public/logo.png",
    path: "web/public/logo.png",
    status: "added",
    binary: true,
    additions: 0,
    deletions: 0,
    lines: [],
  },
];

// ---- stored diff rounds (DiffView) ----

// The common case: one stored round (no round headers shown).
export const singleRound: PatchDiff[] = [
  {
    seq: 1,
    files: diffFiles,
  },
];

// A follow-up round addressing feedback — same file touched again with line
// numbers that owe nothing to round 1 (rounds are independent).
export const multiRound: PatchDiff[] = [
  ...singleRound,
  {
    seq: 2,
    files: [
      {
        oldPath: "server/db.ts",
        newPath: "server/db.ts",
        path: "server/db.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 0,
        lines: [
          dl("hunk", null, null, "@@ -12,3 +12,4 @@ export function open(path: string) {"),
          dl("context", 12, 12, '  db.exec("PRAGMA foreign_keys = ON;");'),
          dl("add", null, 13, '  db.exec("PRAGMA busy_timeout = 5000;");'),
          dl("context", 13, 14, "  return db;"),
        ],
      },
    ],
  },
];

// A round whose hunk rows advertise held-but-unrendered context, as a wide
// capture does: `up` is the gap above each hunk, and `down` rides the LAST hunk
// only, covering the file's trailing lines (every other downward gap is the next
// hunk's `up`, so reporting both would double-count one gap).
export const expandableRound: PatchDiff[] = [
  {
    seq: 1,
    files: [
      {
        oldPath: "server/db.ts",
        newPath: "server/db.ts",
        path: "server/db.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 1,
        lines: [
          {
            ...dl("hunk", null, null, "@@ -40,5 +40,5 @@ export function open(path: string) {"),
            expandable: { up: 39, down: 0 },
          },
          dl("context", 40, 40, '  db.exec("PRAGMA journal_mode = WAL;");'),
          dl("del", 41, null, '  db.exec("PRAGMA synchronous = FULL;");'),
          dl("add", null, 41, '  db.exec("PRAGMA synchronous = NORMAL;");'),
          dl("context", 42, 42, "  return db;"),
          {
            ...dl("hunk", null, null, "@@ -80,3 +80,3 @@ export function close() {"),
            expandable: { up: 37, down: 64 },
          },
          dl("context", 80, 80, "export function close(db: Database) {"),
          dl("context", 81, 81, "  db.close();"),
        ],
      },
    ],
  },
];

// A round with a line far wider than the panel — exercises the single
// horizontal scrollbar per file (one scrollbar for the whole diff, not one per
// line). Short rows and their add/del backgrounds still span the full scroll
// width.
export const wideRound: PatchDiff[] = [
  {
    seq: 1,
    files: [
      {
        oldPath: "server/config.ts",
        newPath: "server/config.ts",
        path: "server/config.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 1,
        lines: [
          dl("hunk", null, null, "@@ -1,4 +1,4 @@"),
          dl("context", 1, 1, "export function allowedHosts(): string[] {"),
          dl(
            "del",
            2,
            null,
            "  return (process.env.R3_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim());",
          ),
          dl(
            "add",
            null,
            2,
            "  return (process.env.R3_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s !== '*' && !s.startsWith('-'));",
          ),
          dl("context", 3, 3, "}"),
        ],
      },
    ],
  },
];

// ---- themes (SettingsPopup) ----

export const themeOptions: ThemeOption[] = [
  { id: "github", label: "GitHub", group: "Auto (light + dark)" },
  { id: "vitesse", label: "Vitesse", group: "Auto (light + dark)" },
  { id: "one", label: "One", group: "Auto (light + dark)" },
  { id: "github-dark", label: "GitHub Dark", group: "Dark" },
  { id: "github-light", label: "GitHub Light", group: "Light" },
];
