import { useSyncExternalStore } from "react";

// The one matchMedia → React bridge, shared by useIsMobile and usePointerCoarse
// so the subscribe/snapshot machinery lives once. Each query gets a single
// cached MediaQueryList: matchMedia allocates a fresh live-tracked object per
// call and useSyncExternalStore re-reads the snapshot every render, so caching
// makes the per-render read allocation-free. The cached subscribe function also
// keeps its identity stable across renders — a fresh subscribe each render
// would make useSyncExternalStore tear down and re-add the listener.
type Entry = { mq: MediaQueryList; subscribe: (onChange: () => void) => () => void };
const entries = new Map<string, Entry>();

function entry(query: string): Entry {
  let e = entries.get(query);
  if (!e) {
    const mq = window.matchMedia(query);
    e = {
      mq,
      subscribe: (onChange) => {
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
      },
    };
    entries.set(query, e);
  }
  return e;
}

export function useMediaQuery(query: string): boolean {
  const e = entry(query);
  return useSyncExternalStore(e.subscribe, () => e.mq.matches);
}
