import { useSyncExternalStore } from "react";
import type { PreviewTheme } from "../../../shared/preview-protocol.ts";

const key = "r3-showcase-theme";
const apply = (theme: PreviewTheme) =>
  document.documentElement.classList.toggle("dark", theme === "dark");
try {
  const saved = localStorage.getItem(key);
  if (saved === "light" || saved === "dark") apply(saved);
} catch {}
const get = () => document.documentElement.classList.contains("dark");
const subscribe = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
function toggle() {
  const theme = get() ? "light" : "dark";
  apply(theme);
  try {
    localStorage.setItem(key, theme);
  } catch {}
}
export const useDarkTheme = () => useSyncExternalStore(subscribe, get);
export function useTheme(): [boolean, () => void] {
  return [useDarkTheme(), toggle];
}
