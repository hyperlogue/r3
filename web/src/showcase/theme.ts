import { useSyncExternalStore } from "react";

const get = () => document.documentElement.classList.contains("dark");
const subscribe = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
export function useTheme(): [boolean, () => void] {
  return [
    useSyncExternalStore(subscribe, get),
    () => document.documentElement.classList.toggle("dark"),
  ];
}
