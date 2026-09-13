import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
const readTheme = () => document.documentElement.classList.contains("dark");
const subscribeTheme = (listener: () => void) => {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
};

export const useDarkTheme = () => useSyncExternalStore(subscribeTheme, readTheme);

export function useTheme(): [boolean, () => void] {
  const dark = useDarkTheme();
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("r3-theme", next ? "dark" : "light");
  };
  return [dark, toggle];
}
