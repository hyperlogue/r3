// Daemon configuration + discovery. The v2 per-user daemon lives
// on a stable port behind one origin, and announces itself in an XDG location so
// the CLI finds it with zero config. This module is intentionally dependency-
// light (node builtins + the shared version) and free of *mutating* side effects
// at import — it does read the persisted config.json read-only, to seed the
// exposure defaults below env (see readConfig/PERSISTED) — so the thin CLI can
// import the path/IO helpers without pulling in the server.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { R3_VERSION } from "../shared/version.ts";

export { R3_VERSION };

const DEFAULT_PORT = 8791;
// The persisted exposure config (config.json), read once at import. It sits
// *below env* in every resolution below (`env ?? PERSISTED ?? default`), so it's
// the durable memory of how the daemon was last configured to serve — surviving a
// restart / lazy-spawn from a shell that never exported the R3_* vars — while a
// one-off `R3_X=… r3 …` still wins for that run. `readConfig`/`writeConfig` are
// defined with the other XDG helpers below (hoisted, so callable here).
const PERSISTED: PersistedConfig = readConfig();
// A *usable* env port wins; an empty/blank/non-numeric R3_PORT — common in shell
// profiles / CI — falls THROUGH to the persisted port, then DEFAULT_PORT (rather
// than jumping straight to the default, which would skip the file layer and break
// the env→file→default precedence). Mirrors how REQUIRE_LOGIN treats an invalid
// R3_REQUIRE_LOGIN as "unset". `|| DEFAULT` also catches a hand-edited port of 0.
const ENV_PORT = Number(process.env.R3_PORT?.trim());
export const PORT =
  (Number.isInteger(ENV_PORT) && ENV_PORT > 0 ? ENV_PORT : PERSISTED.port) || DEFAULT_PORT;
// Bind address. Default loopback; a non-loopback bind (e.g. a tailnet addr) is
// an explicit opt-in that also requires a Host allowlist.
export const BIND = process.env.R3_BIND?.trim() || PERSISTED.bind || "127.0.0.1";

// The on-box URL the daemon advertises to the local CLI + uses for self-health.
// Loopback for a loopback/all-interfaces bind (also what an `ssh -L
// <PORT>:localhost:<PORT>` forward targets); the bind address itself when bound
// to a specific non-loopback interface (still local to the box, so reachable).
const HEALTH_HOST = BIND === "0.0.0.0" || BIND === "::" ? "127.0.0.1" : BIND;
export const LOCAL_URL = `http://${HEALTH_HOST}:${PORT}`;
// The URL surfaced in agent-printed review links + the served page. Defaults to
// loopback (works through an SSH forward that maps the same port); override with
// `R3_PUBLIC_URL` for a tailnet/MagicDNS address (e.g. a `tailscale serve` name).
export const PUBLIC_URL =
  (process.env.R3_PUBLIC_URL?.trim() || PERSISTED.publicUrl || "").replace(/\/+$/, "") || LOCAL_URL;

// The hostname a URL advertises, or null if it can't be parsed (a malformed
// R3_PUBLIC_URL contributes no host rather than throwing at import).
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

// Loopback host names — always trusted (a loopback bind, or an `ssh -L` forward,
// is already access-controlled). The allowlist seeds from these, and `REQUIRE_LOGIN`
// (below) uses them to default the login policy.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

// Does a URL advertise a loopback host? A URL that can't be parsed is treated as
// non-loopback (conservative — an odd advertised host reads as "exposed"). Used by
// `r3 status` to tell an exposed daemon from a loopback one and by `r3 config set`
// to warn about exposing with login off.
export function isLoopbackUrl(url: string): boolean {
  const h = hostnameOf(url);
  return h != null && isLoopbackHost(h);
}

// Host allowlist for the DNS-rebinding + CSRF defenses. Loopback names are always
// allowed; `R3_ALLOWED_HOSTS` adds exact extra names (e.g. a MagicDNS name — never
// `*`, which would gut the rebinding defense). A non-loopback bind address is
// allowed too, so reaching the bound IP works. The **public origin's host is
// allowed implicitly**: we hand that URL out (in review links + the served page),
// so it must resolve — which makes a single `R3_PUBLIC_URL=https://<name>` enough
// for the common `tailscale serve` case, with no separate R3_ALLOWED_HOSTS.
const PUBLIC_HOST = hostnameOf(PUBLIC_URL);
// Extra allowed Host names: env if present (even empty — an explicit
// `R3_ALLOWED_HOSTS=""` overrides to clear), else the persisted list, else none.
const EXTRA_HOSTS: string[] =
  process.env.R3_ALLOWED_HOSTS != null
    ? process.env.R3_ALLOWED_HOSTS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : (PERSISTED.allowedHosts ?? []);
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  ...EXTRA_HOSTS,
  // A specific non-loopback bind address is allowed (so reaching the bound IP
  // works); the all-interfaces wildcards (v4 `0.0.0.0`, v6 `::`) are not — they
  // aren't a Host a client sends, and r3's model is never-all-interfaces.
  ...(!["127.0.0.1", "localhost", "0.0.0.0", "::"].includes(BIND) ? [BIND] : []),
  // The advertised public host (skipping loopback — already covered — and the
  // all-interfaces wildcards, which are never a real Host). `new URL().hostname`
  // brackets an IPv6 literal, so `::` arrives as `[::]` — exclude both forms.
  ...(PUBLIC_HOST &&
  !isLoopbackHost(PUBLIC_HOST) &&
  !["0.0.0.0", "::", "[::]"].includes(PUBLIC_HOST)
    ? [PUBLIC_HOST]
    : []),
]);

export function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.has(hostname);
}

// Must the web UI log in (a login token → session cookie), or does /api/boot hand
// the browser the per-user token directly? This is a **login policy**, not a
// detected fact: r3 can't tell from a request whether the client is truly local (a
// reverse proxy can rewrite/forge Host and Origin), so it's decided once at startup
// from how the operator configured access, and it's the whole auth switch —
//   off (the default): the daemon binds loopback and advertises no extra host, so
//     every client is already local; the browser gets the per-user token from
//     /api/boot, no login (zero-friction, unchanged).
//   on: the web UI requires a **login token** (server/auth.ts) for every session,
//     and the master token never goes to a browser.
// Defaults on iff any non-loopback access is configured: a non-loopback bind (incl.
// the all-interfaces wildcards `0.0.0.0`/`::`, which aren't in the allowlist) OR ANY
// non-loopback name in the Host allowlist — which folds in a non-loopback
// `R3_PUBLIC_URL` (auto-allowed above) and `R3_ALLOWED_HOSTS`. Allowing a remote Host
// is itself the signal: it's what makes r3 reachable by that name, so it arms the
// gate. `R3_REQUIRE_LOGIN=1|0` forces it either way — set it to 1 behind a reverse
// proxy that rewrites Host to loopback, which r3 has no way to detect.
// Parse a boolean-ish flag string (1/true/yes → true, 0/false/no → false, else
// null). Shared by the R3_REQUIRE_LOGIN env read here and `r3 config set
// requireLogin` in the CLI, so the env and persisted paths accept exactly the
// same tokens (no drift).
export function parseBoolFlag(v: string | undefined): boolean | null {
  const t = v?.trim().toLowerCase();
  if (t === "1" || t === "true" || t === "yes") return true;
  if (t === "0" || t === "false" || t === "no") return false;
  return null;
}
export const REQUIRE_LOGIN =
  parseBoolFlag(process.env.R3_REQUIRE_LOGIN) ??
  PERSISTED.requireLogin ??
  (!isLoopbackHost(BIND) || [...ALLOWED_HOSTS].some((h) => !isLoopbackHost(h)));

// $XDG_STATE_HOME/r3 (default ~/.local/state/r3): the persistent home for the
// global sqlite, the per-user token, and the fallback daemon.json.
export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "r3");
}

// ---- persisted exposure config (config.json) ----
//
// The durable record of how the daemon should serve — bind/port/public URL/allowed
// hosts/require-login — so a restart or lazy-spawn from a shell without the R3_*
// env vars keeps the last remote-serving posture instead of silently reverting to
// loopback-only. Written explicitly via `r3 config set` (never auto-persisted from
// env), read as the fallback below env in the resolutions at the top of this file.
// Carries NO secrets (just hostnames/flags); the per-user token stays in stateDir.
export interface PersistedConfig {
  bind?: string;
  port?: number;
  publicUrl?: string;
  allowedHosts?: string[];
  requireLogin?: boolean;
}

// $XDG_CONFIG_HOME/r3 (default ~/.config/r3): the home for config.json. Separate
// from the state dir (data) and the runtime dir (volatile daemon.json/lock).
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "r3");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

// Keep only correctly-typed fields. config.json is hand-editable, so a wrong-typed
// value must fail SAFE — dropped, so the setting falls to env/derived default —
// rather than corrupt security state: a bare-string `allowedHosts` would otherwise
// spread into the Host allowlist *character by character* (single-letter Hosts
// allowed, the intended host silently not), and a non-boolean `requireLogin` (a
// string, or the number 0) would slip past a `??` check and flip the login gate.
function sanitizeConfig(o: Record<string, unknown>): PersistedConfig {
  const out: PersistedConfig = {};
  if (typeof o.bind === "string") out.bind = o.bind;
  if (typeof o.port === "number" && Number.isInteger(o.port)) out.port = o.port;
  if (typeof o.publicUrl === "string") out.publicUrl = o.publicUrl;
  if (Array.isArray(o.allowedHosts) && o.allowedHosts.every((h) => typeof h === "string")) {
    out.allowedHosts = o.allowedHosts as string[];
  }
  if (typeof o.requireLogin === "boolean") out.requireLogin = o.requireLogin;
  return out;
}

// Parse config JSON text into a validated PersistedConfig. THROWS on invalid JSON
// (the caller decides tolerate-vs-error); a parseable non-object (array, number,
// null) and wrong-typed fields are normalized away by sanitizeConfig.
function parseConfig(text: string): PersistedConfig {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return sanitizeConfig(raw as Record<string, unknown>);
}

// Read the persisted config, tolerating an absent or malformed file (→ {}), so a
// bad file can never wedge daemon startup or the CLI's import of this module.
export function readConfig(): PersistedConfig {
  try {
    return parseConfig(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

// Like readConfig, but for the MUTATING CLI path (`config set`/`unset`): it
// distinguishes "absent" (fresh {}) from "present but unparseable" (throws), so a
// merge-then-write never silently discards the other keys of a file we couldn't
// read. Wrong-typed but parseable fields are still tolerated (sanitized away).
export function readConfigForWrite(): PersistedConfig {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch {
    return {}; // absent → start fresh
  }
  return parseConfig(text); // a JSON syntax error propagates to the caller
}

// Persist the config (the whole object; callers merge). Pretty-printed and
// trailing-newline'd so it's hand-editable. No secret, so no 0600 dance. Written
// to a temp file then renamed so a daemon reading config.json mid-write never sees
// a truncated file (rename is atomic on the same filesystem).
export function writeConfig(next: PersistedConfig): void {
  const p = configPath();
  ensureDir(dirname(p));
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, p);
}

// $XDG_RUNTIME_DIR/r3: volatile per-boot dir; the natural home for daemon.json
// (it carries a live pid/port). Null when the runtime dir isn't set.
function runtimeDir(): string | null {
  const r = process.env.XDG_RUNTIME_DIR?.trim();
  return r ? join(r, "r3") : null;
}

// daemon.json: runtime dir if available (volatile, matches the daemon's
// lifetime), else the state dir. One canonical path so the writer (daemon) and
// the reader (CLI) always agree.
export function daemonJsonPath(): string {
  return join(runtimeDir() ?? stateDir(), "daemon.json");
}

// The global review store. `R3_DB` overrides for tests.
export function stateDbPath(): string {
  return process.env.R3_DB?.trim() || join(stateDir(), "r3.sqlite");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export interface DaemonInfo {
  url: string;
  port: number;
  pid: number;
  token: string;
  version: string;
  // How this daemon was launched, recorded by the serving process itself:
  // `exec` is its binary/interpreter (process.execPath — the compiled r3 binary,
  // or the bun that ran the script), `argv` the full command line
  // (process.argv). Surfaced by `r3 status` so you can see which binary is
  // actually serving. Optional: a daemon started before this field existed omits
  // them.
  exec?: string;
  argv?: string[];
  // The exposure posture this daemon actually resolved at startup (its own
  // env+config.json), so `r3 status` can report whether it's serving remotely and
  // whether login is required — even when the querying shell has different env.
  // Optional: a daemon predating these fields omits them.
  publicUrl?: string;
  requireLogin?: boolean;
}

export function readDaemonJson(): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(daemonJsonPath(), "utf8")) as DaemonInfo;
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

export function writeDaemonJson(info: DaemonInfo): void {
  const p = daemonJsonPath();
  ensureDir(dirname(p));
  // Create with mode 0o600 atomically: a plain write leaves the file briefly
  // world-readable (umask 022 → 0644) before the chmod lands — a TOCTOU window
  // in which the token it carries is exposed. `mode` applies only when the file
  // is created, so the chmod stays as belt-and-suspenders to tighten a
  // pre-existing file. (0o600 & ~umask keeps owner rw, no group/other.)
  writeFileSync(p, JSON.stringify(info, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // carries the token — a local secret
  } catch {}
}

export function removeDaemonJson(): void {
  try {
    rmSync(daemonJsonPath());
  } catch {}
}

// ---- daemon start lock ----
//
// Bun's listener enables SO_REUSEPORT, so two daemons can bind the same port —
// the port alone is NOT a mutual-exclusion lock. An O_EXCL pidfile is: only one
// concurrent spawn creates it, and a crashed daemon's stale lock (dead pid) is
// stolen on the next start. Combined with `reusePort:false` on the listener as
// defense-in-depth.

// Colocate the lock with daemon.json (same volatile dir) so their lifetimes
// match: after a reboot $XDG_RUNTIME_DIR is cleared, dropping BOTH. A lock left
// in the persistent state dir would outlive daemon.json and — if its recorded
// pid got reused — wedge every lazy-spawn until manually removed.
function lockPath(): string {
  return join(runtimeDir() ?? stateDir(), "daemon.lock");
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch (e) {
    // EPERM means it exists but isn't ours (shouldn't happen, single-user); ESRCH = gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Try to become the sole starting daemon. Returns true if we hold the lock.
export function acquireDaemonLock(): boolean {
  const lock = lockPath();
  ensureDir(dirname(lock));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lock, "wx"); // O_CREAT | O_EXCL — atomic create-or-fail
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held — by a live daemon, or stale from a crash?
      let owner = 0;
      try {
        owner = Number(readFileSync(lock, "utf8").trim());
      } catch {}
      if (owner !== process.pid && isPidAlive(owner)) return false; // someone else holds it
      try {
        rmSync(lock); // stale (dead/empty owner) — steal and retry
      } catch {}
    }
  }
  return false;
}

export function releaseDaemonLock(): void {
  try {
    if (Number(readFileSync(lockPath(), "utf8").trim()) === process.pid) rmSync(lockPath());
  } catch {}
}

// The per-user token: one secret gating all of the single user's
// repos, persisted in XDG (mode 0600) so it survives a restart — keeping
// injected-into-the-page browser sessions and bookmarked URLs valid. `R3_TOKEN`
// overrides. Lazily generated so importing this module has no side effects.
export function getToken(): string {
  if (process.env.R3_TOKEN) return process.env.R3_TOKEN;
  const f = join(stateDir(), "token");
  try {
    const existing = readFileSync(f, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const tok = randomBytes(24).toString("hex");
  ensureDir(stateDir());
  // Create with mode 0o600 atomically so the secret is never briefly world-
  // readable (umask 022 → 0644) between the write and the chmod — closing the
  // TOCTOU window. The chmod stays as belt-and-suspenders for the (unlikely)
  // pre-existing-file case, where `mode` on writeFileSync isn't applied.
  writeFileSync(f, tok, { mode: 0o600 });
  try {
    chmodSync(f, 0o600);
  } catch {}
  return tok;
}
