// One flat KEYMAP + one window listener. KEYMAP is the source for both the
// dispatcher and the `?` overlay. Handlers register per-component.

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
  | "layoutToggle"
  | "panelHide"
  | "panelToggle";

export interface Binding {
  id: KeyId;
  // Chords, in the normalized form chordOf() produces below. Case matters — `S`
  // is the shifted key, and that is load-bearing (see the handOff note).
  keys: string[];
  label: string;
  group: "Review" | "Feedback" | "Files" | "View";
  // Opt in to OS key repeat. Off by default because most of this map MUTATES and
  // repeat fires ~30×/s: a leaned-on `e` walks the whole list resolving items
  // (each resolve advances focus to the next card, which the next repeat then
  // resolves), and a leaned-on `S` re-fires the hand-off. Only the four
  // navigation bindings — which just move a selection — are safe to hold.
  repeatable?: boolean;
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
  {
    id: "fbNext",
    keys: ["j", "ctrl+n"],
    label: "Next feedback",
    group: "Feedback",
    repeatable: true,
  },
  {
    id: "fbPrev",
    keys: ["k", "ctrl+p"],
    label: "Previous feedback",
    group: "Feedback",
    repeatable: true,
  },
  // `o`, not Enter: a focused button already activates on Enter natively, so a
  // global Enter binding would fight it or double-fire depending on where focus
  // sits. Enter stays unbound everywhere.
  { id: "fbLocate", keys: ["o"], label: "Jump to its anchor", group: "Feedback" },
  { id: "fbReply", keys: ["r"], label: "Reply", group: "Feedback" },
  { id: "fbResolve", keys: ["e"], label: "Resolve / reopen", group: "Feedback" },

  { id: "fileNext", keys: ["]"], label: "Next file", group: "Files", repeatable: true },
  { id: "filePrev", keys: ["["], label: "Previous file", group: "Files", repeatable: true },
  { id: "filePicker", keys: ["f"], label: "Jump to file…", group: "Files" },
  { id: "fileFold", keys: ["z"], label: "Fold / unfold current file", group: "Files" },
  { id: "foldAll", keys: ["Z"], label: "Fold / unfold all files", group: "Files" },
  { id: "fileViewed", keys: ["x"], label: "Mark current file viewed", group: "Files" },
  { id: "fileNote", keys: ["a"], label: "Feedback on current file", group: "Files" },

  { id: "versionNext", keys: [">"], label: "Next diff round / version", group: "View" },
  { id: "versionPrev", keys: ["<"], label: "Previous diff round / version", group: "View" },
  { id: "layoutToggle", keys: ["\\"], label: "Unified / side-by-side", group: "View" },
  // ArtifactView toggles the desktop dock or the mobile feedback sheet.
  { id: "panelToggle", keys: ["p"], label: "Show / hide feedback panel", group: "View" },
  { id: "panelHide", keys: ["Escape"], label: "Hide feedback panel", group: "View" },
];

const CHORDS = new Map<string, KeyId>();
for (const b of KEYMAP) for (const k of b.keys) CHORDS.set(k, b.id);
const REPEATABLE = new Set<KeyId>(KEYMAP.filter((b) => b.repeatable).map((b) => b.id));

// Pretty-print named keys and chords for the overlay; characters stay literal.
export function formatChord(chord: string): string {
  if (chord === "Escape") return "Esc";
  return chord.startsWith("ctrl+") ? `Ctrl-${chord.slice(5)}` : chord;
}

// Focus is in something that takes typed text, so the keystroke belongs to it.
// Deliberately NARROWER than isInteractiveTarget: this map never binds Space or
// Enter, so a focused button or link can keep its shortcuts. Standing down for
// those too would mean a shortcut silently stops working after a toolbar click.
export function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// True when focus is on an element that should own the keystroke itself — a text
// field (which receives the character) or an interactive control like a button or
// link (Space activates it; Esc may dismiss its own popup). A global Space/Esc
// handler must stand down for these so it doesn't hijack normal interaction.
export function isInteractiveTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return isTextEntry(el) || tag === "BUTTON" || tag === "A" || el.getAttribute("role") === "button";
}

// The chord a keydown represents, or null when nothing here could match it.
// Single-character keys and unmodified Escape are bindable; Alt/Meta chords,
// F-keys, and arrows are left to the browser, OS, and individual widgets.
function chordOf(e: KeyboardEvent): string | null {
  if (e.metaKey || e.altKey) return null;
  if (e.key === "Escape") return e.ctrlKey || e.shiftKey ? null : e.key;
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

// For the OTHER global key listeners this map doesn't own — notably the
// composer's Escape action in ArtifactView. Without this the shortcuts sheet's
// own Esc and the composer's would both fire on one press: the sheet closes AND
// the open composer is discarded.
export function keysSuspended(): boolean {
  return suspended > 0;
}

// Whether anything currently owns `id`. The `?` sheet greys the rest, so a key
// that doesn't apply to the view on screen reads as unavailable instead of
// looking live and silently doing nothing.
export function isBound(id: KeyId): boolean {
  return handlers.has(id);
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
    // Swallow the key either way (a held `S` must not leak anywhere), but only
    // the navigation bindings actually re-fire on OS key repeat — see Binding.
    e.preventDefault();
    if (e.repeat && !REPEATABLE.has(id)) return;
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
