// A tiny persisted external store: one value mirrored to localStorage and read
// via useSyncExternalStore, so settings state stays in sync across the
// components that read it without context or prop-drilling. Factored out of
// settings.ts, whose syntax-theme and font-size stores each hand-rolled the
// same listeners/getter/setter/subscribe boilerplate.

import { useSyncExternalStore } from "react";

export function persistedStore<T>(
  key: string,
  opts: {
    load: (raw: string | null) => T; // parse the persisted string (null = unset)
    save?: (value: T) => string | null; // serialize; return null to remove the key
    onSet?: (value: T) => void; // side effect on set (e.g. a CSS var) — not on load
  },
) {
  const save = opts.save ?? ((v: T) => String(v));
  let value = opts.load(localStorage.getItem(key));
  const listeners = new Set<() => void>();
  const get = () => value;
  const set = (next: T) => {
    value = next;
    const raw = save(value);
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    opts.onSet?.(value);
    for (const l of listeners) l();
  };
  // Stable subscribe reference so consumers don't unsubscribe/resubscribe on
  // every render (a fresh inline arrow would).
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const use = () => useSyncExternalStore(subscribe, get);
  return { get, set, use };
}
