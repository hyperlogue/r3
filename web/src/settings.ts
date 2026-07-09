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
const clampFont = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));

const font = persistedStore<number>("r3-font-size", {
  load: (raw) => clampFont(Number(raw) || FONT_DEFAULT),
  onSet: (px) => document.documentElement.style.setProperty("--r3-font-size", `${px}px`),
});
export const getFontSize = font.get;
export const useFontSize = font.use;
export function setFontSize(px: number): void {
  font.set(clampFont(px));
}
