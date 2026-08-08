// The keyboard layer: one flat keymap, one window listener.
//
// Two rules shape this, both deliberate:
//
//   1. Every binding fires a control that already exists on screen. Nothing here
//      invents a capability, a mode, or review state — a shortcut is a keystroke
//      for a button you could have clicked. That is what keeps the map short
//      enough to hold in your head and what keeps this file free of behaviour.
//   2. Selection stays MOUSE-ONLY. There is no cursor, no visual mode, no
//      operator grammar, so there is nothing to parse: a chord maps to an id,
//      an id maps to a handler. If you find yourself adding modal state here,
//      that is the signal the scope grew.
//
// KEYMAP is the single source for BOTH the dispatcher and the `?` overlay
// (ShortcutsOverlay renders straight off it), so the help can't drift from the
// behaviour — the same one-source shape as `hasUnsentContent` in shared/types.ts.
//
// Handlers register per-component: whoever owns the state owns the binding
// (FeedbackPanel takes the feedback group, ReviewView the file/view group,
// JumpToFile its own opener). That avoids lifting state or drilling props purely
// to serve a keystroke.

import { useEffect, useRef } from "react";

export type KeyId =
  | "help"
  | "generalNote"
  | "handOff"
  | "fbNext"
  | "fbPrev"
  | "fbLocate"
  | "fbReply"
  | "fbResolve"
  | "fileNext"
  | "filePrev"
  | "filePicker"
  | "fileFold"
  | "foldAll"
  | "fileViewed"
  | "fileNote"
  | "versionNext"
  | "versionPrev"
  | "layoutToggle";

export interface Binding {
  id: KeyId;
  // Chords, in the normalized form chordOf() produces below. Case matters — `S`
  // is the shifted key, and that is load-bearing (see the handOff note).
  keys: string[];
  label: string;
  group: "Review" | "Feedback" | "Files" | "View";
}

export const KEYMAP: readonly Binding[] = [
  { id: "help", keys: ["?"], label: "Keyboard shortcuts", group: "Review" },
  { id: "generalNote", keys: ["n"], label: "New general feedback", group: "Review" },
  // Shifted on purpose: the only binding that sends data out of the app, with no
  // keyboard undo once the agent has it. Everything else in this map is locally
  // reversible, so `S` reads like `Z` (fold *all*) — the bigger, less casual key.
  { id: "handOff", keys: ["S"], label: "Submit / Copy prompt", group: "Review" },

  // `Ctrl-n`/`Ctrl-p` are ALIASES, not the primary. On macOS both are free
  // (browsers put new-window and print on ⌘). On Windows/Linux they split:
  // Ctrl-p can be cancelled, Ctrl-n cannot — it is a reserved browser shortcut
  // that opens a window whatever we do. j/k behave identically everywhere, so
  // they are what the overlay leads with.
  { id: "fbNext", keys: ["j", "ctrl+n"], label: "Next feedback", group: "Feedback" },
  { id: "fbPrev", keys: ["k", "ctrl+p"], label: "Previous feedback", group: "Feedback" },
  // `o`, not Enter: a focused button already activates on Enter natively, so a
  // global Enter binding would fight it or double-fire depending on where focus
  // sits. Enter stays unbound everywhere.
  { id: "fbLocate", keys: ["o"], label: "Jump to its anchor", group: "Feedback" },
  { id: "fbReply", keys: ["r"], label: "Reply", group: "Feedback" },
  { id: "fbResolve", keys: ["e"], label: "Resolve / reopen", group: "Feedback" },

  { id: "fileNext", keys: ["]"], label: "Next file", group: "Files" },
  { id: "filePrev", keys: ["["], label: "Previous file", group: "Files" },
  { id: "filePicker", keys: ["f"], label: "Jump to file…", group: "Files" },
  { id: "fileFold", keys: ["z"], label: "Fold / unfold current file", group: "Files" },
  { id: "foldAll", keys: ["Z"], label: "Fold / unfold all files", group: "Files" },
  { id: "fileViewed", keys: ["x"], label: "Mark current file viewed", group: "Files" },
  { id: "fileNote", keys: ["a"], label: "Feedback on current file", group: "Files" },

  { id: "versionNext", keys: [">"], label: "Next diff round / version", group: "View" },
  { id: "versionPrev", keys: ["<"], label: "Previous diff round / version", group: "View" },
  { id: "layoutToggle", keys: ["\\"], label: "Unified / side-by-side", group: "View" },
];

const CHORDS = new Map<string, KeyId>();
for (const b of KEYMAP) for (const k of b.keys) CHORDS.set(k, b.id);

// Pretty-print a chord for the overlay: "ctrl+n" -> "Ctrl-n", everything else is
// already the literal character you press.
export function formatChord(chord: string): string {
  return chord.startsWith("ctrl+") ? `Ctrl-${chord.slice(5)}` : chord;
}

// Focus is in something that takes typed text, so the keystroke belongs to it.
// Deliberately NARROWER than isInteractiveTarget: this map binds only letters and
// punctuation — never Space or Enter — so a focused button or link can keep its
// shortcuts. Standing down for those too would mean a shortcut silently stops
// working after you click any toolbar button.
export function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// True when focus is on an element that should own the keystroke itself — a text
// field (which receives the character) or an interactive control like a button or
// link (Space activates it; Esc may dismiss its own popup). A global Space/Esc
// handler must stand down for these so it doesn't hijack normal interaction.
// Moved here from FeedbackPanel so the composer's Esc handling and this layer
// agree on one definition.
export function isInteractiveTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return isTextEntry(el) || tag === "BUTTON" || tag === "A" || el.getAttribute("role") === "button";
}

// The chord a keydown represents, or null when nothing here could match it. Only
// single-character keys are bindable (no F-keys, no arrows), and Alt/Meta chords
// are left entirely to the browser and the OS.
function chordOf(e: KeyboardEvent): string | null {
  if (e.metaKey || e.altKey) return null;
  if (e.key.length !== 1) return null;
  // Ctrl chords normalize to lowercase so Ctrl-n and Ctrl-N are the same binding;
  // an unmodified key keeps its case, which is how `S` and `Z` differ from `s`/`z`.
  return e.ctrlKey ? `ctrl+${e.key.toLowerCase()}` : e.key;
}

const handlers = new Map<KeyId, () => void>();

// While a modal owns the screen (the shortcuts overlay), everything but `help`
// stands down — otherwise `j` would be quietly walking the feedback list behind
// the sheet. A counter, not a boolean, so overlapping suspensions can't leave the
// map dead.
let suspended = 0;
export function suspendKeys(): () => void {
  suspended++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspended--;
  };
}

let attached = false;
function ensureListener() {
  if (attached) return;
  attached = true;
  window.addEventListener("keydown", (e) => {
    // Something nearer the event already claimed it (a composer's ⌘↵, a popup's
    // Esc), or an IME is mid-composition and every keystroke is text.
    if (e.defaultPrevented || e.isComposing) return;
    if (isTextEntry(document.activeElement)) return;
    const chord = chordOf(e);
    if (!chord) return;
    const id = CHORDS.get(chord);
    if (!id) return;
    if (suspended > 0 && id !== "help") return;
    const fn = handlers.get(id);
    if (!fn) return;
    e.preventDefault();
    fn();
  });
}

export type KeyHandlers = Partial<Record<KeyId, (() => void) | undefined>>;

// Register the bindings this component owns for as long as it is mounted.
//
// The handler map is read through a ref, so passing a fresh object literal every
// render is fine — the effect re-runs only when the SET of bound ids changes, not
// when the closures do. An id whose handler is undefined stays unbound, so a
// component can drop a binding conditionally (e.g. no layout toggle when no diff
// is on screen) and the key falls through to doing nothing.
export function useKeyBindings(map: KeyHandlers): void {
  const latest = useRef(map);
  latest.current = map;
  const ids = (Object.keys(map) as KeyId[]).filter((id) => map[id]).sort();
  // The dep is the SET of bound ids, not the map: re-registering on every render
  // (the caller passes a fresh object literal) would churn the handler table for
  // nothing, since each entry reads its closure live through `latest`.
  const idsKey = ids.join(",");
  useEffect(() => {
    ensureListener();
    const mine = (idsKey ? (idsKey.split(",") as KeyId[]) : []).map((id) => {
      const fn = () => latest.current[id]?.();
      handlers.set(id, fn);
      return [id, fn] as const;
    });
    return () => {
      // Only drop our own entry: a component unmounting after another registered
      // the same id (a remount overlapping its predecessor) must not clear theirs.
      for (const [id, fn] of mine) if (handlers.get(id) === fn) handlers.delete(id);
    };
  }, [idsKey]);
}
