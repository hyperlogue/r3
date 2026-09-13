import type { PreviewTheme } from "../../shared/preview-protocol.ts";

// Only this artifact's light/dark preference crosses the preview bridge. It has
// no storage key argument and cannot read application settings or other artifacts.
export function previewThemePreference(
  storage: () => Pick<Storage, "getItem" | "setItem">,
  artifactId: string,
) {
  const key = `r3-artifact-theme:${artifactId}`;
  return {
    get: (): PreviewTheme | null => {
      const saved = storage().getItem(key);
      return saved === "light" || saved === "dark" ? saved : null;
    },
    set: (theme: PreviewTheme) => storage().setItem(key, theme),
  };
}
