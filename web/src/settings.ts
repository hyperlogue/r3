// Client display settings (font size + syntax theme) as tiny external stores so
// the settings popup and the views that consume them (FileView/DiffView query
// keys) stay in sync without prop-drilling or context. Built on the shared
// persistedStore factory (store.ts). Dark mode lives in hooks.ts (useTheme)
// since it predates this.

import { persistedStore } from "./store.ts";

// ---- syntax highlight theme (mirrors server/highlight.ts THEME_FAMILIES) ----

export const SYNTAX_THEMES = [
  { id: "github", label: "GitHub" },
  { id: "vitesse", label: "Vitesse" },
  { id: "one", label: "One" },
  { id: "material", label: "Material" },
  { id: "catppuccin", label: "Catppuccin" },
] as const;

const syntax = persistedStore<string>("r3-syntax-theme", {
  load: (raw) => raw || "github",
});
export const getSyntaxTheme = syntax.get;
export const setSyntaxTheme = syntax.set;
export const useSyntaxTheme = syntax.use;

// ---- font size ----

// The value is the root <html> font-size in px; Tailwind's rem-based utilities
// scale off it (see main.css). 16 is the neutral base Tailwind is calibrated
// for; the default is 2px larger.
export const FONT_MIN = 11;
export const FONT_MAX = 24;
const FONT_DEFAULT = 18;
// Exported so the pre-paint boot read in main.tsx clamps identically (same bounds,
// same rounding) instead of re-deriving the formula.
export const clampFont = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));

// ---- diff layout (unified vs side-by-side) ----

// How DiffView renders a diff: one interleaved column ("unified", the default) or
// two parallel old/new columns ("split"). A pure render mode — the server ships
// the same `DiffFileChange.lines` either way, and the pairing happens in the
// client — so this is a display preference like the two above, NOT review state:
// it never reaches the server and never bumps `review.updated_at`.
//
// Global rather than per-review on purpose: which layout you read diffs in is a
// habit, not a property of any one review. The phone tier forces unified
// (two code columns don't fit) WITHOUT writing here, so a split-preferring user
// gets split back the moment the viewport is wide again — see ReviewView.
export type DiffLayout = "unified" | "split";

const diffLayout = persistedStore<DiffLayout>("r3-diff-layout", {
  load: (raw) => (raw === "split" ? "split" : "unified"),
});
export const getDiffLayout = diffLayout.get;
export const setDiffLayout = diffLayout.set;
export const useDiffLayout = diffLayout.use;

const font = persistedStore<number>("r3-font-size", {
  load: (raw) => clampFont(Number(raw) || FONT_DEFAULT),
  onSet: (px) => document.documentElement.style.setProperty("--r3-font-size", `${px}px`),
});
export const useFontSize = font.use;
// The non-reactive read, for the rem→px math outside React (pane.ts's sticky-band
// helper): rem-sized chrome is only a fixed pixel count if you know this value.
export const getFontSize = font.get;
export function setFontSize(px: number): void {
  font.set(clampFont(px));
}
