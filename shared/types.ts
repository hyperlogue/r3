// Artifact HTTP contracts, source/diff presentation, application bootstrap, and
// publisher-local wake targets. Historical storage rows live in server/migration-data.ts.
export * from "./artifacts.ts";

export type DiffSide = "old" | "new";

// Source/diff gestures preserve the full line span and cap only its quoted text.
// Rendered targets use native DOM/text evidence through the preview protocol.
export const MAX_QUOTE_LINES = 4;

export function capQuote(raw: string): string {
  // trimEnd(), not /\s+$/: it strips the same character set, and the regex
  // backtracks per start offset over a long whitespace run (quadratic on the
  // mostly-blank selections a client can make).
  const quote = raw.trimEnd();
  const lines = quote.split("\n");
  return lines.length > MAX_QUOTE_LINES ? lines.slice(0, MAX_QUOTE_LINES).join("\n") : quote;
}

// Maximum captured context rows a client requests at once. Larger gaps expand
// in successive requests; shared with the server's captured-patch validation.
export const MAX_CONTEXT_ROWS = 5000;

// ---- source/diff presentation ----

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  oldLine: number | null;
  newLine: number | null;
  // Pre-highlighted inner HTML for the line content (Shiki). For 'hunk' rows
  // this is the literal @@ header text (not highlighted).
  html: string;
  text: string; // raw text of the line (no leading +/-/space), for quote anchoring
  // Retained patch evidence: this side's final line had no newline terminator.
  noNewline?: true;
  // Hunk rows: held context for expand (`down` on the last hunk of each contiguous
  // run). Absent/zero = no expander.
  expandable?: { up: number; down: number };
}

export interface DiffFileChange {
  oldPath: string | null;
  newPath: string | null;
  path: string; // display path (newPath ?? oldPath)
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[]; // flat list including hunk header rows
}

// One selected publication's highlighted patch, consumed by the diff renderer.
// ArtifactVersion owns its metadata; the renderer needs only identity and rows.
export interface PatchDiff {
  seq: number;
  files: DiffFileChange[];
}

// One entry in the syntax-theme picker (GET /api/themes): a curated light/dark
// family or a single bundled Shiki theme, grouped for the dropdown.
export interface ThemeOption {
  id: string;
  label: string;
  group: string;
}

// The current syntax theme's own editor colours (GET /api/theme-style): its
// background and default foreground, per light/dark slot. The client paints code
// surfaces with these (as --shiki-*-bg / --shiki-*) so a theme like Nord looks
// like it does in an editor instead of pale token colours on r3's neutral card.
// Blank strings ⇒ the client keeps its neutral fallback.
export interface ThemeStyle {
  lightBg: string;
  darkBg: string;
  lightFg: string;
  darkFg: string;
  // The theme's PALETTE STYLESHEET — where every rendered token span's colour
  // comes from. One rule per distinct foreground the theme can hand a token
  // (`html:not(.dark) .sl3{color:#…}` for the light slot, `html.dark .sd7{…}`
  // for the dark one) plus the font-style rules; the spans carry only the
  // matching class names. Spans used to carry both colours inline instead
  // (`style="--shiki-light:…;--shiki-dark:…"`), which measured 12x the source
  // size in blob JSON and gave every mounted span its own computed style. The
  // client injects this once as `<style data-r3-theme-css>`, replacing it when
  // the theme changes. Blank ⇒ no palette (unloadable theme): those lines fall
  // back to inline styles on a `.sx` span, so nothing renders colourless.
  css: string;
}

export interface RenderedFileLine {
  lineNo: number;
  // Shiki-highlighted inner HTML. Token spans carry palette classes
  // (`<span class="sl3 sd7">`), coloured by ThemeStyle.css for the SAME theme —
  // both are per-theme, so a client must not mix a line from one theme's render
  // with another theme's stylesheet.
  html: string;
  text: string; // raw line text for anchoring
}

// ---- publisher-local wake adapters ----

// Harness addresses and credentials stay on the publisher. The artifact daemon
// sees the logical agent session and its outward stream, never these targets.
export interface ClaudeListenerTarget {
  harness: "claude";
  socket: string;
  token: string;
}

export interface CodexListenerTarget {
  harness: "codex";
  threadId: string;
}

export type ListenerTarget = ClaudeListenerTarget | CodexListenerTarget;

// ---- auth (login token → session cookie when REQUIRE_LOGIN) ----

// GET /api/boot. `needsAuth:true` → login screen; `token` is then null.
export interface BootResponse {
  needsAuth: boolean;
  // The per-user API token when login isn't required (the SPA sends it as
  // x-r3-token, as it always has); null when login is required (the browser
  // authenticates by the session cookie alone, so the master token stays on the box).
  token: string | null;
}

// A login token's metadata (GET /api/auth/tokens, `r3 auth list-tokens`). The token
// value itself is hashed at rest and shown only once at creation — never returned.
export interface AuthTokenInfo {
  id: string; // authtok_<short> — the handle used to revoke
  label: string | null; // human hint (device/purpose)
  createdAt: string;
  lastUsedAt: string | null; // last successful login with this token; null if unused
  // (revoked tokens are dropped from every listing, so there's no `revokedAt` here —
  // the audit-trail column stays DB-side; see server/auth.ts AuthService.)
  // Request-scoped, not stored: true for the token that minted the caller's own
  // session cookie (GET /api/auth/tokens only). Revoking it would sign the caller
  // out, so the server refuses that DELETE and the UI disables its revoke button.
  // Absent when the caller used the per-user token (loopback SPA / CLI, no cookie).
  current?: boolean;
}

// POST /api/auth/login — trade a login token for a session cookie (Set-Cookie in the
// response). Same-origin gated, token-free (you have no session yet). 401 on a bad
// or revoked token.
export interface LoginBody {
  token: string;
}

// POST /api/auth/tokens — mint a login token. The raw `token` is returned ONCE here
// and never again (only its hash is stored); persist it somewhere safe.
export interface CreateAuthTokenBody {
  label?: string | null;
}
export interface CreateAuthTokenResponse {
  token: string; // the one-time plaintext login token
  info: AuthTokenInfo;
}
