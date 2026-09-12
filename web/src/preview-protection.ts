import { useSyncExternalStore } from "react";

export type PreviewVerification = "checking" | "ready" | "error";

const KEY = "r3:preview-compatibility:v1";
const CHANGED = "r3-preview-compatibility-changed";
let temporaryConsent: boolean | null = null;
let warningShown = false;
let warningOwner: object | null = null;

function accepted(): boolean {
  if (temporaryConsent !== null) return temporaryConsent;
  try {
    return localStorage.getItem(KEY) === "accepted";
  } catch {
    return false;
  }
}

function save(value: boolean) {
  temporaryConsent = value;
  try {
    if (value) localStorage.setItem(KEY, "accepted");
    else localStorage.removeItem(KEY);
    temporaryConsent = null;
  } catch {
    // Storage-denied/private contexts remember only for this application load.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(changed: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      temporaryConsent = null;
      changed();
    }
  };
  window.addEventListener("storage", storage);
  window.addEventListener(CHANGED, changed);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(CHANGED, changed);
  };
}

// This acknowledgment never enables broader external resources or devices.
// Every new preview still attempts verified network protection first.
export const previewCompatibility = {
  accepted,
  accept: () => save(true),
  forget: () => save(false),
  requestWarning(owner: object, explicit = false): boolean {
    if (warningOwner || (!explicit && warningShown)) return false;
    warningOwner = owner;
    warningShown = true;
    return true;
  },
  closeWarning(owner: object) {
    if (warningOwner === owner) warningOwner = null;
  },
  suppressWarning() {
    warningShown = true;
  },
};

export function useCompatibilityConsent() {
  return useSyncExternalStore(subscribe, accepted, () => false);
}
