import { useSyncExternalStore } from "react";
import type { ArtifactUtility, PreviewTheme } from "../../../shared/preview-protocol.ts";

const utility = (
  globalThis as typeof globalThis & {
    __r3ArtifactUtility?: Partial<Pick<ArtifactUtility, "getTheme" | "setTheme">>;
  }
).__r3ArtifactUtility;
const key = "r3-showcase-theme";
const apply = (theme: PreviewTheme) =>
  document.documentElement.classList.toggle("dark", theme === "dark");
let toggled = false;
if (utility?.getTheme) {
  void utility
    .getTheme()
    .then((theme) => {
      if (theme && !toggled) apply(theme);
    })
    .catch(() => {});
} else {
  // Standalone workshop builds have their own origin; published previews use
  // the scoped bridge above, retaining their opaque sandbox.
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") apply(saved);
  } catch {
    /* Browser storage can be unavailable. */
  }
}
const get = () => document.documentElement.classList.contains("dark");
const subscribe = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
function toggle() {
  toggled = true;
  const theme = get() ? "light" : "dark";
  apply(theme);
  if (utility?.setTheme) void utility.setTheme(theme).catch(() => {});
  else {
    try {
      localStorage.setItem(key, theme);
    } catch {
      /* Keep the current visit usable. */
    }
  }
}
export const useDarkTheme = () => useSyncExternalStore(subscribe, get);
export function useTheme(): [boolean, () => void] {
  return [useDarkTheme(), toggle];
}
