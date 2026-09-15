import { useSyncExternalStore } from "react";

// Practice navigation never leaves the publication or writes opaque-origin history.
let route = "/";
const listeners = new Set<() => void>();
export const hrefFor = (_route: string) => "#practice";
export function navigate(next: string) {
  route = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function useRoute() {
  const path = useSyncExternalStore(subscribe, () => route);
  const match = path.match(/^\/(artifact_[\w]+)$/);
  return { path, artifactId: match?.[1] ?? null };
}
