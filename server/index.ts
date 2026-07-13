// r3 daemon — the authoritative store + HTTP/JSON contract shared by the browser
// SPA, the CLI, and the agent. Bun + Hono + bun:sqlite.
// One long-running per-user daemon on a stable port; binds 127.0.0.1 by default;
// mutating routes are same-origin + token gated. Announces itself in an XDG
// `daemon.json` so the CLI finds it with zero config. `startDaemon()` is
// the entry point; importing this module only mints-or-reads the per-user token
// (`const TOKEN = getToken()` below — a cheap, idempotent fs side effect) and
// does not serve, so the thin CLI can import it (to spawn the daemon in-process)
// without standing up an HTTP listener.

import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type {
  AddPatchBody,
  BootResponse,
  CreateAuthTokenBody,
  CreateAuthTokenResponse,
  CreateReviewBody,
  CreateSnapshotBody,
  LoginBody,
  ReviewFilesBody,
  ReviewStatus,
  ServerEvent,
  UpdateReviewBody,
} from "../shared/types.ts";
// The SPA entry. Bun's bundler turns this import into an HTMLBundle: on-demand
// from source (dev + lazy-spawn, via the bun-plugin-tailwind in bunfig.toml),
// and pre-bundled + embedded into the binary by `scripts/compile.ts`. Served
// natively below through Bun.serve's `routes`.
import index from "../web/index.html";
import * as auth from "./auth.ts";
import {
  acquireDaemonLock,
  BIND,
  type DaemonInfo,
  getToken,
  isAllowedHost,
  LOCAL_URL,
  PORT,
  PUBLIC_URL,
  R3_VERSION,
  REQUIRE_LOGIN,
  readDaemonJson,
  releaseDaemonLock,
  removeDaemonJson,
  writeDaemonJson,
} from "./config.ts";
import * as db from "./db.ts";
import { getDiff, gitLog, gitStatus, gitTree, isSafeRef, resolveRev, snapshotDiff } from "./git.ts";
import { listThemes, themeStyle } from "./highlight.ts";
import { patchInfos, renderPatches } from "./patches.ts";
import { buildPrompt, buildUnsentPrompt } from "./prompt.ts";
import { renderFile } from "./render.ts";
import { commonDirOf, type Repo, resolveRepoById, resolveRepoFromHeader } from "./repo.ts";
import * as reviews from "./reviews.ts";
import { migrateLegacyDocFiles, scratchReviewDir } from "./scratch.ts";
import { renderSnapshotBlob, renderSnapshotDiff } from "./snapshots.ts";
import { broadcast, subscribe } from "./sse.ts";
import { startWatcher } from "./watcher.ts";
import { addWatcher, removeWatcher, watchersOf } from "./watchers.ts";

const TOKEN = getToken();
// Origin surfaced in agent-printed review URLs + the served page (loopback by
// default; a tailnet/MagicDNS address via R3_PUBLIC_URL). The CLI reaches us at
// LOCAL_URL (loopback / SSH-forward) regardless.
const ORIGIN = PUBLIC_URL;

// Only an allowed-Host page (or a no-Origin client like the CLI/curl) may mutate.
// The port pin is dropped so an SSH forward / proxy that changes the port
// still works; the Host allowlist + token are the real CSRF/rebinding defenses.
function sameOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  try {
    return isAllowedHost(new URL(o).hostname);
  } catch {
    return false;
  }
}

// Constant-time compare so the token can't be recovered a byte at a time by
// timing the response — a real concern once the daemon is reachable over an SSH
// forward / tailnet. `timingSafeEqual` throws on unequal lengths, so gate on
// length first (the length isn't the secret); a null/absent candidate is a miss.
function tokenEq(candidate: string | null): boolean {
  if (candidate == null) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The request's Host, port stripped (bracketed IPv6 kept intact:
// "[::1]:8791" -> "[::1]"). Null when absent.
function reqHostname(req: Request): string | null {
  const host = req.headers.get("host");
  if (!host) return null;
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

// The Host must be one of ours (loopback, an allowlisted MagicDNS name, or the
// advertised public host — config.ts). Defends against DNS-rebinding: an attacker
// page that rebinds its domain to our IP still sends its own domain as Host, so
// it's rejected before it can read any endpoint.
function allowedHost(req: Request): boolean {
  const h = reqHostname(req);
  return h != null && isAllowedHost(h);
}

// Is the browser<->edge leg HTTPS? The daemon always speaks plain HTTP (it holds no
// cert; TLS terminates at a proxy like `tailscale serve`), so the only signal is the
// proxy's X-Forwarded-Proto. Keyed per-request — NOT off R3_PUBLIC_URL's scheme,
// which would wrongly mark the cookie Secure on a plain-HTTP leg to the same daemon
// (loopback, or a bound IP over http), making the browser drop it → a silent login
// loop / dead SSE. Used only for the session cookie's Secure attribute.
function isHttps(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https";
}

// Resolve a request's authentication: the per-user API token (header/bearer — the
// CLI, and the SPA when login isn't required) OR a valid session cookie (a browser
// that logged in — only possible when login is required). No mode branch needed: a
// cookie simply doesn't exist unless login is required.
function resolveAuth(c: Context): boolean {
  const authz = c.req.header("authorization");
  const bearer = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
  const header = c.req.header("x-r3-token") ?? null;
  if (tokenEq(bearer) || tokenEq(header)) return true;
  return auth.sessionValid(getCookie(c, auth.COOKIE_NAME));
}

const app = new Hono();

// Every request must target an allowed host (DNS-rebinding defense).
app.use("*", async (c, next) => {
  if (!allowedHost(c.req.raw)) return c.text("forbidden (host)", 403);
  await next();
});

// Guard the API surface. Auth is the per-user token (header/bearer) OR a valid
// session cookie (resolveAuth). Reads require it too: loopback is reachable by every
// local UID, and the Host allowlist stops DNS-rebinding but is NOT a local-user
// boundary. Always token-free:
//   /api/health — discovery (the CLI probes it before it holds any token)
//   /api/boot   — bootstraps the token/cookie itself (same-origin gated in its handler)
//   /api/auth/login (POST) — trades a login token for a session (you have none yet);
//                            still same-origin gated below
// /api/events (SSE) is token-free ONLY when login isn't required (loopback-only, and
// EventSource can't set headers); when login is required, a session cookie rides
// EventSource, so it's gated like any read. Every state-changing verb (incl. PUT —
// the …/viewed route) stays same-origin gated; a stray verb must not fall to the read
// path.
app.use("/api/*", async (c, next) => {
  const m = c.req.method;
  const p = c.req.path;
  if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
    if (!sameOrigin(c.req.raw)) return c.text("forbidden (origin)", 403);
    if (p !== "/api/auth/login" && !resolveAuth(c)) return c.text("forbidden (token)", 403);
  } else {
    const tokenFree =
      p === "/api/health" || p === "/api/boot" || (p === "/api/events" && !REQUIRE_LOGIN);
    if (!tokenFree && !resolveAuth(c)) return c.text("forbidden (token)", 403);
  }
  await next();
});

// Clamp a numeric query param that is handed to git into [min,max] (floored to an
// integer). Untrusted values must not reach git verbatim: `?limit=-1` becomes
// `git log --max-count=-1` (an unbounded full-history dump), `?cursor=-5` becomes
// `--skip=-5`, and `?contextLines=99999999` forces whole-file context on every
// hunk. A non-numeric value falls back to `d` (callers pass a default in-range).
const clampNum = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

// JSON response for the highlight-heavy endpoints (/api/blob, /api/diff) with a
// content ETag + gzip. The ETag is a hash of the body, so it's correct even for
// WORKING/STAGED content: an unchanged review re-viewed (reload, second tab)
// revalidates to a 304 with no re-download; changed content gets a fresh body.
// `Cache-Control: no-cache` = always revalidate (cheap on loopback), never serve
// stale. Compression is done here (not as middleware) to keep it away from the
// SSE stream, which must not be buffered/compressed. (design: r3-blob-compress-cache)
function jsonCached(c: Context, obj: unknown): Response {
  const json = JSON.stringify(obj);
  const etag = `"${Bun.hash(json).toString(16)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  c.header("Vary", "Accept-Encoding");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("Content-Type", "application/json; charset=utf-8");
  // Only worth compressing past a small floor (highlighted blobs are 100s of KB).
  if (json.length > 1024 && (c.req.header("accept-encoding") || "").includes("gzip")) {
    c.header("Content-Encoding", "gzip");
    return c.body(Bun.gzipSync(Buffer.from(json)));
  }
  return c.body(json);
}

// Resolve the Repo a request acts on. Most specific first: an
// id-addressed `?review=` (the row carries its repo), then the CLI's
// `x-r3-repo` header, then a `?repo=<id>` selector (browser). The daemon is
// repo-agnostic — it holds no ambient "default repo" — so a request that names
// none resolves to null, and the caller returns 400 "no repo context". (A CLI
// call run outside any git repo sends no header, so `r3 create` there is a 400
// rather than binding to some arbitrary repo.) A *creating* mutation passes
// `allowReview:false`: a new review must bind to the actor's own repo
// (header/selector), never an arbitrary `?review` selector.
async function requestRepo(
  c: {
    req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined };
  },
  opts: { allowReview?: boolean } = {},
): Promise<Repo | null> {
  if (opts.allowReview !== false) {
    const reviewId = c.req.query("review");
    if (reviewId) {
      const r = await reviews.repoForReview(reviewId);
      if (r) return r;
    }
  }
  const header = c.req.header("x-r3-repo");
  if (header) {
    const r = resolveRepoFromHeader(header);
    if (r) return r;
  }
  const repoId = c.req.query("repo");
  if (repoId) {
    const r = await resolveRepoById(repoId);
    if (r) return r;
  }
  return null;
}

// ---- health / bootstrap ----
// Liveness + version only (no repo details — no client reads them). `version`
// lets the CLI detect daemon/client skew after a binary upgrade.
app.get("/api/health", (c) => c.json({ ok: true, version: R3_VERSION }));

// Bootstrap the SPA before it renders (web/src/api.ts loadBoot). Same-origin gated;
// not injected into the served HTML — keeping the SPA shell a cacheable/embeddable
// static asset. Behaviour splits on REQUIRE_LOGIN (config.ts):
//   login not required (default, loopback-only) — every client is already local:
//     hand the same-origin page the per-user `token` (its header path, unchanged).
//   login required (tailscale serve / bound IP / R3_REQUIRE_LOGIN) — require a
//     login-token session: a valid cookie -> { needsAuth:false, token:null } (the
//     master token never goes to a browser); else { needsAuth:true } -> login screen.
// sameOrigin() still passes a no-Origin client (curl from another local UID); when
// login isn't required that's the intentional local-trust boundary, not a new hole (a
// real per-UID boundary needs an OS peer-credential check — see Security in AGENTS.md).
app.get("/api/boot", (c) => {
  if (!sameOrigin(c.req.raw)) return c.text("forbidden (origin)", 403);
  if (!REQUIRE_LOGIN) return c.json({ needsAuth: false, token: TOKEN } satisfies BootResponse);
  if (auth.sessionValid(getCookie(c, auth.COOKIE_NAME)))
    return c.json({ needsAuth: false, token: null } satisfies BootResponse);
  return c.json({ needsAuth: true, token: null } satisfies BootResponse, 401);
});

// ---- auth: login tokens -> session cookies (see shared/types.ts, server/auth.ts) ----

// Trade a login token for a session cookie. Token-free (you have none yet) but
// same-origin gated by the middleware; 401 on a bad/revoked token.
app.post("/api/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as LoginBody | null;
  if (typeof body?.token !== "string") return c.text("missing token", 400);
  const res = auth.verifyLogin(body.token);
  if (!res) return c.text("invalid token", 401);
  const { cookieValue, maxAgeSeconds } = auth.mintSession(res.tokenId);
  setCookie(c, auth.COOKIE_NAME, cookieValue, auth.cookieOptions(isHttps(c), maxAgeSeconds));
  return c.json({ ok: true });
});

// End the current session (drops the row + expires the cookie).
app.post("/api/auth/logout", (c) => {
  auth.destroySession(getCookie(c, auth.COOKIE_NAME));
  deleteCookie(c, auth.COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

// Login-token management — the CLI (`r3 auth …`) and the settings UI share these.
app.get("/api/auth/tokens", (c) => c.json(db.listAuthTokens()));

app.post("/api/auth/tokens", async (c) => {
  const body = (await c.req.json().catch(() => null)) as CreateAuthTokenBody | null;
  const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim() : null;
  const { token, info } = auth.createLoginToken(label);
  return c.json({ token, info } satisfies CreateAuthTokenResponse);
});

// Revoke all live login tokens (and their sessions). Distinct path from the :id
// form so it can't be reached by a stray id.
app.delete("/api/auth/tokens", (c) => c.json({ revoked: db.revokeAllAuthTokens() }));

app.delete("/api/auth/tokens/:id", (c) =>
  db.revokeAuthToken(c.req.param("id")) ? c.json({ ok: true }) : c.text("not found", 404),
);

// Syntax-theme options for the settings picker (curated families + all bundled
// Shiki themes). Static, so it's safe to cache hard in the browser.
app.get("/api/themes", (c) => c.json(listThemes()));

// The selected theme's own editor background + default foreground, so the client
// can paint code surfaces the way the theme looks in an editor.
app.get("/api/theme-style", async (c) =>
  c.json(await themeStyle(c.req.query("theme") || undefined)),
);

// ---- git browsing ----
// A stale repo's worktree is gone/missing: its git cwd doesn't exist or
// is the wrong tree, so content routes return empty rather than 500 / render the
// fallback primary worktree as if it were the review's. The UI shows the stale
// banner from the review detail.
app.get("/api/git/status", async (c) => {
  const repo = await requestRepo(c);
  if (!repo) return c.text("no repo context", 400);
  if (repo.stale) return c.json({ branch: null, ahead: 0, behind: 0, entries: [] });
  return c.json(await gitStatus(repo));
});
app.get("/api/git/log", async (c) => {
  const repo = await requestRepo(c);
  if (!repo) return c.text("no repo context", 400);
  if (repo.stale) return c.json([]);
  // Clamp so a hostile `?limit`/`?cursor` can't turn into an unbounded git dump
  // or a negative `--skip` (see clampNum): limit in [1,500], cursor in [0,∞).
  return c.json(
    await gitLog(
      repo,
      clampNum(c.req.query("limit"), 50, 1, 500),
      clampNum(c.req.query("cursor"), 0, 0, Number.MAX_SAFE_INTEGER),
    ),
  );
});
app.get("/api/git/tree", async (c) => {
  const repo = await requestRepo(c);
  if (!repo) return c.text("no repo context", 400);
  if (repo.stale) return c.json([]);
  const ref = c.req.query("ref") || "HEAD";
  if (!isSafeRef(ref)) return c.text("bad ref", 400);
  return c.json(await gitTree(repo, ref, c.req.query("path") || undefined));
});
app.get("/api/diff", async (c) => {
  const repo = await requestRepo(c);
  if (!repo) return c.text("no repo context", 400);
  const base = c.req.query("base") || "HEAD";
  const head = c.req.query("head") || "WORKING";
  if (!isSafeRef(base) || !isSafeRef(head)) return c.text("bad ref", 400);
  // WORKING is never a valid base, and STAGED is a valid base only paired with
  // head=WORKING (plain `git diff` — working tree vs index; diffArgs special-cases
  // it). Any other pairing falls through to a bogus `git diff <sentinel> …` → git
  // error → uncaught 500, so reject it up front.
  if (base === "WORKING" || (base === "STAGED" && head !== "WORKING"))
    return c.text("bad ref", 400);
  if (repo.stale) return c.json({ base, head, files: [] });
  return jsonCached(
    c,
    await getDiff(repo, base, head, {
      ignoreWhitespace: c.req.query("ignoreWhitespace") === "1",
      // Clamp to [0,100] so a huge value can't force whole-file context per hunk.
      context: clampNum(c.req.query("contextLines"), 3, 0, 100),
      theme: c.req.query("theme") || undefined,
    }),
  );
});
app.get("/api/blob", async (c) => {
  const repo = await requestRepo(c);
  if (!repo) return c.text("no repo context", 400);
  const path = c.req.query("path");
  const ref = c.req.query("ref") || "WORKING";
  if (!path) return c.text("missing path", 400);
  if (!isSafeRef(ref)) return c.text("bad ref", 400);
  // SCRATCH content lives in the data dir, so a stale worktree doesn't block it.
  if (repo.stale && ref !== "SCRATCH") return c.text("not found", 404);
  const rendered = await renderFile(repo, path, ref, c.req.query("theme") || undefined);
  return rendered ? jsonCached(c, rendered) : c.text("not found", 404);
});

// ---- repos registry ----
app.get("/api/repos", (c) =>
  c.json(db.listRepos().map((r) => ({ ...r, present: existsSync(r.commonDir) }))),
);
app.patch("/api/repos/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.name !== "string") return c.text("missing name", 400);
  const r = db.renameRepo(c.req.param("id"), body.name);
  return r ? c.json(r) : c.text("not found", 404);
});
// Relink a moved repo: recompute its common-dir from the new path. Not
// automatic — only the human knows a move from a copy.
app.post("/api/repos/:id/relink", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const path = String(body?.path ?? "");
  if (!path) return c.text("missing path", 400);
  const commonDir = await commonDirOf(path);
  if (!commonDir) return c.text("not a git repo", 400);
  // common_dir is UNIQUE — relinking onto a path already owned by another repo
  // would throw a constraint error; report it cleanly instead of a 500.
  const owner = db.getRepoByCommonDir(commonDir);
  if (owner && owner.id !== id) return c.text(`that path is already project ${owner.id}`, 409);
  const r = db.relinkRepo(id, commonDir);
  return r ? c.json(r) : c.text("not found", 404);
});
// Forget a repo + its reviews (cascade). Routed through reviews.deleteRepo so any
// doc reviews' data-dir files are unlinked too (the SQL cascade can't reach them).
app.delete("/api/repos/:id", (c) =>
  reviews.deleteRepo(c.req.param("id")) ? c.json({ ok: true }) : c.text("not found", 404),
);

// ---- reviews ----
app.get("/api/reviews", (c) => {
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.queries())) {
    if (!k.startsWith("meta.")) continue;
    const key = k.slice(5);
    // Skip an empty meta key (`?meta.=x`): it would reach db.listReviews as
    // json_extract(meta,'$.') → a SQLite path error → 500. (The db layer hardens
    // this too; this keeps the bad param from ever forming a filter.)
    if (!key) continue;
    meta[key] = Array.isArray(v) ? v[0] : (v as string);
  }
  return c.json(
    db
      .listReviews({
        session: c.req.query("session") || undefined,
        status: (c.req.query("status") as ReviewStatus) || undefined,
        repoId: c.req.query("repo") || undefined,
        meta: Object.keys(meta).length ? meta : undefined,
      })
      // Live-derived: does this review have an agent blocked on `r3 watch` right
      // now? Ephemeral connection presence (like RepoRecord.present), so clients
      // can float watched reviews to the top of the list.
      .map((r) => ({ ...r, watching: watchersOf(r.id).length > 0 })),
  );
});

app.post("/api/reviews", async (c) => {
  let body: CreateReviewBody;
  try {
    body = await c.req.json();
  } catch {
    return c.text("bad json", 400);
  }
  // The review is bound to the actor's own repo + worktree (header/selector/
  // default), never a `?review` selector.
  const repo = await requestRepo(c, { allowReview: false });
  if (!repo) return c.text("no repo context", 400);

  // Scratch review: an empty files/SCRATCH review plus a per-review directory the
  // agent drops files into. No git refs, no upload; the watcher keeps the
  // file list + content live. The directory path is returned as `scratchDir`.
  if (body.scratch) {
    const review = reviews.createScratchReview({
      repo,
      title: body.title ?? null,
      summary: body.summary ?? null,
      meta: body.meta ?? {},
      created_by: body.created_by ?? "human",
    });
    broadcast({ type: "reviews-changed" });
    return c.json({
      id: review.id,
      url: `${ORIGIN}/${review.id}`,
      review,
      scratchDir: scratchReviewDir(review.id),
    });
  }

  if (body.kind !== "diff" && body.kind !== "files") return c.text("bad kind", 400);

  // Diff review: snapshot once and store the patch as round 1 — the
  // content of record from here on; `source` stays as provenance. A raw patch in
  // the body (`--stdin-diff`) skips git entirely.
  if (body.kind === "diff") {
    let source = { base: "", head: "" };
    let patch = typeof body.patch === "string" ? body.patch : null;
    if (!patch) {
      if (!body.source || !("base" in body.source)) return c.text("missing source", 400);
      // Reject option-injecting refs before they reach git; pin refs to full
      // shas so the provenance label survives a rebase.
      if (!isSafeRef(body.source.base) || !isSafeRef(body.source.head))
        return c.text("bad ref", 400);
      source = {
        base: await resolveRev(repo, body.source.base),
        head: await resolveRev(repo, body.source.head),
      };
      if (repo.stale) return c.text("worktree unavailable", 409);
      try {
        patch = await snapshotDiff(repo, source.base, source.head);
      } catch {
        return c.text("git diff failed (bad ref?)", 400);
      }
    }
    const review = reviews.createDiffReview({
      repo,
      source,
      patch,
      label: body.label ?? null,
      meta: body.meta ?? {},
      title: body.title ?? null,
      summary: body.summary ?? null,
      created_by: body.created_by ?? "human",
    });
    if (reviews.isRejected(review)) return c.text(review.error, 400);
    broadcast({ type: "reviews-changed" });
    return c.json({ id: review.id, url: `${ORIGIN}/${review.id}`, review });
  }

  if (!body.source || !("ref" in body.source)) return c.text("missing source", 400);
  if (!isSafeRef(body.source.ref)) return c.text("bad ref", 400);
  // Validate the initial file list the same way `r3 files add` (updateReviewFiles)
  // does, so nothing that couldn't be added later is persisted at create: reject
  // empty, absolute, `..`-segmented, or NUL-bearing paths. Reads still go through
  // safePath, so this isn't an escape today — it just keeps stored membership
  // clean and consistent with the edit path.
  const files = Array.isArray(body.source.files) ? body.source.files : [];
  for (const f of files) {
    if (!f || f.startsWith("/") || f.split(/[/\\]/).includes("..") || f.includes("\0"))
      return c.text("bad path", 400);
  }
  // Pin an immutable ref to its full sha for stable anchoring.
  const source = { ref: await resolveRev(repo, body.source.ref), files };
  const review = db.createReview({
    repoId: repo.repoId,
    worktree: repo.descriptor,
    kind: body.kind,
    source,
    meta: body.meta ?? {},
    title: body.title ?? null,
    summary: body.summary ?? null,
    created_by: body.created_by ?? "human",
  });
  // Push so the multi-project sidebar updates live when an agent (CLI) creates a
  // review in any repo, not just the browser tab that did it.
  broadcast({ type: "reviews-changed" });
  return c.json({ id: review.id, url: `${ORIGIN}/${review.id}`, review });
});

app.get("/api/reviews/:id", async (c) => {
  const detail = await reviews.buildReviewDetail(c.req.param("id"));
  return detail ? c.json(detail) : c.text("not found", 404);
});

app.patch("/api/reviews/:id", async (c) => {
  let body: UpdateReviewBody;
  try {
    body = await c.req.json();
  } catch {
    return c.text("bad json", 400);
  }
  const id = c.req.param("id");
  const updated = db.updateReview(id, body);
  if (!updated) return c.text("not found", 404);
  // A rename / summary edit / status flip should reach the open review + the
  // sidebar live, and wake a blocked `r3 watch` when a review is approved/abandoned
  // (review-updated refreshes the detail; reviews-changed the multi-project list).
  broadcast({ type: "review-updated", reviewId: id });
  broadcast({ type: "reviews-changed" });
  return c.json(updated);
});

app.delete("/api/reviews/:id", (c) =>
  reviews.deleteReview(c.req.param("id")) ? c.json({ ok: true }) : c.text("not found", 404),
);

// ---- stored diff rounds ----

// A diff review's rendered content: its stored rounds in seq order. A legacy
// review with no stored patches (unresolvable at migration) renders live from
// its source refs as a single synthetic round (seq 0).
app.get("/api/reviews/:id/diff", async (c) => {
  const id = c.req.param("id");
  const review = db.getReview(id);
  if (review?.kind !== "diff") return c.text("not found", 404);
  const theme = c.req.query("theme") || undefined;
  if (db.hasPatches(id)) return jsonCached(c, { rounds: await renderPatches(id, theme) });
  const src = review.source as { base: string; head: string };
  const repo = await reviews.repoForReview(id);
  if (!repo || repo.stale || !isSafeRef(src.base) || !isSafeRef(src.head))
    return c.json({ rounds: [] });
  const live = await getDiff(repo, src.base, src.head, { theme });
  return jsonCached(c, {
    rounds: [
      { seq: 0, label: null, summary: null, created_at: review.created_at, files: live.files },
    ],
  });
});

// Round metas + stats (`r3 diff list`).
app.get("/api/reviews/:id/patches", (c) => {
  const review = db.getReview(c.req.param("id"));
  if (review?.kind !== "diff") return c.text("not found", 404);
  return c.json(patchInfos(review.id));
});

// Append a round (`git diff … | r3 diff add`).
app.post("/api/reviews/:id/patches", async (c) => {
  const body = (await c.req.json().catch(() => null)) as AddPatchBody | null;
  if (typeof body?.patch !== "string") return c.text("missing patch", 400);
  const res = reviews.addPatchToReview(
    c.req.param("id"),
    body.patch,
    body.label ?? null,
    body.summary ?? null,
  );
  if (!res) return c.text("not found", 404);
  if (reviews.isRejected(res)) return c.text(res.error, 400);
  return c.json(res);
});

// Remove a round (`r3 diff rm`). Anchors pointing into it are kept, shown inert.
app.delete("/api/reviews/:id/patches/:seq", (c) => {
  const seq = Number(c.req.param("seq"));
  if (!Number.isInteger(seq)) return c.text("bad seq", 400);
  return reviews.removePatch(c.req.param("id"), seq)
    ? c.json({ ok: true })
    : c.text("not found", 404);
});

// Per-reviewer viewed-state. Server-persisted so read-progress
// follows the review across browsers; the `key` encodes content identity so a diff
// round's file and a live file at a given sha are distinct marks. No SSE broadcast
// — a second tab reconciles on refetch. Behind the global token guard (reads too);
// the PUT also gets same-origin from the mutating-route middleware.
app.get("/api/reviews/:id/viewed", (c) => {
  const id = c.req.param("id");
  if (!db.getReview(id)) return c.text("not found", 404);
  return c.json({ keys: db.listViewed(id) });
});

app.put("/api/reviews/:id/viewed", async (c) => {
  const id = c.req.param("id");
  if (!db.getReview(id)) return c.text("not found", 404);
  const body = await c.req.json().catch(() => null);
  if (typeof body?.key !== "string" || typeof body?.viewed !== "boolean")
    return c.text("bad body", 400);
  // Opaque token, not a path — no safePath needed; just a sanity bound so a
  // malformed client can't wedge oversized rows into the store.
  if (body.key.length < 1 || body.key.length > 512) return c.text("bad key", 400);
  db.setViewed(id, body.key, body.viewed);
  return c.json({ ok: true });
});

// Edit a files review's membership (`r3 files add/rm`).
app.post("/api/reviews/:id/files", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ReviewFilesBody | null;
  if (!body || (!Array.isArray(body.add) && !Array.isArray(body.remove)))
    return c.text("missing add/remove", 400);
  const res = reviews.updateReviewFiles(c.req.param("id"), {
    add: Array.isArray(body.add) ? body.add.map(String) : undefined,
    remove: Array.isArray(body.remove) ? body.remove.map(String) : undefined,
  });
  if (!res) return c.text("not found", 404);
  if (reviews.isRejected(res)) return c.text(res.error, 400);
  return c.json(res);
});

// ---- files-review content snapshots ----

// Parse a `to` snapshot ref query param: WORKING (default) or a snapshot seq.
// Returns null when it's a seq that doesn't exist on this review.
function parseSnapshotTo(reviewId: string, raw: string | undefined): number | "WORKING" | null {
  if (!raw || raw === "WORKING") return "WORKING";
  const n = Number(raw);
  return Number.isInteger(n) && db.hasSnapshot(reviewId, n) ? n : null;
}

// Capture a snapshot of the review's current file contents (`r3 snapshot`).
app.post("/api/reviews/:id/snapshots", async (c) => {
  const body = (await c.req.json().catch(() => null)) as CreateSnapshotBody | null;
  const res = await reviews.snapshotReview(c.req.param("id"), body?.label ?? null);
  if (!res) return c.text("not found", 404);
  if (reviews.isRejected(res)) return c.text(res.error, 400);
  return c.json(res);
});

// Snapshot metas + file lists (`r3 snapshot list`; also in the review detail).
app.get("/api/reviews/:id/snapshots", (c) => {
  const review = db.getReview(c.req.param("id"));
  if (review?.kind !== "files") return c.text("not found", 404);
  return c.json(db.listSnapshotMetas(review.id));
});

// Remove a snapshot whole (`r3 snapshot rm`). Feedback isn't scoped to snapshots,
// so nothing orphans — it just leaves the from/to picker.
app.delete("/api/reviews/:id/snapshots/:seq", (c) => {
  const seq = Number(c.req.param("seq"));
  if (!Number.isInteger(seq)) return c.text("bad seq", 400);
  return reviews.removeSnapshot(c.req.param("id"), seq)
    ? c.json({ ok: true })
    : c.text("not found", 404);
});

// The derived diff between two snapshot refs: from=<seq>, to=<seq|WORKING>. The
// files that land in this view are located client-side by quote, so this
// response is feedback-agnostic and content-ETag cacheable.
app.get("/api/reviews/:id/snapshot-diff", async (c) => {
  const id = c.req.param("id");
  const review = db.getReview(id);
  if (review?.kind !== "files") return c.text("not found", 404);
  const from = Number(c.req.query("from"));
  if (!Number.isInteger(from) || !db.hasSnapshot(id, from)) return c.text("bad from", 400);
  const to = parseSnapshotTo(id, c.req.query("to"));
  if (to === null) return c.text("bad to", 400);
  const repo = await reviews.repoForReview(id);
  const files = await renderSnapshotDiff(
    id,
    from,
    to,
    repo,
    review,
    c.req.query("theme") || undefined,
  );
  return jsonCached(c, { from, to, files });
});

// A file rendered at a snapshot ref, full-file (the from=None browse mode):
// to=<seq|WORKING>. WORKING reads live; a seq reads the stored content.
app.get("/api/reviews/:id/snapshot-blob", async (c) => {
  const id = c.req.param("id");
  const review = db.getReview(id);
  if (review?.kind !== "files") return c.text("not found", 404);
  const path = c.req.query("path");
  if (!path) return c.text("missing path", 400);
  const to = parseSnapshotTo(id, c.req.query("to"));
  if (to === null) return c.text("bad to", 400);
  const repo = await reviews.repoForReview(id);
  const rendered = await renderSnapshotBlob(
    id,
    to,
    path,
    repo,
    review,
    c.req.query("theme") || undefined,
  );
  return rendered ? jsonCached(c, rendered) : c.text("not found", 404);
});

// Read-only prompt preview — marks NOTHING (unlike the POST below, which stamps
// sent_at). Two shapes:
//   default        — full history: every candidate item, whole thread (`r3
//                     prompt --all`, the escape hatch that always re-prints all).
//   ?scope=unsent  — the unsent-only hand-off text WITHOUT marking it delivered.
//                     The web previews with this before writing the clipboard,
//                     then POSTs (which marks) only on a successful copy — so a
//                     failed copy no longer silently burns the unsent state.
// The CLI is unaffected (it uses the POST). Optional `?feedback=<id,id>` narrows.
app.get("/api/reviews/:id/prompt", async (c) => {
  const detail = await reviews.buildReviewDetail(c.req.param("id"));
  if (!detail) return c.text("not found", 404);
  const fb = c.req.query("feedback");
  const feedbackIds = fb
    ? fb
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  if (c.req.query("scope") === "unsent")
    return c.text(buildUnsentPrompt(detail, { feedbackIds }).text);
  return c.text(buildPrompt(detail, { feedbackIds }));
});

// Unsent-only prompt — builds only what the agent hasn't seen and marks it
// delivered. Mutating (it stamps sent_at), so it's behind the
// same-origin + token guard above; this is the default hand-off used by the UI's
// Copy/Submit and by `r3 prompt` / `r3 watch`. Optional `{ feedback: string[] }`
// narrows to a subset (never forces already-sent content back in).
app.post("/api/reviews/:id/prompt", async (c) => {
  const body = await c.req.json().catch(() => null);
  const feedbackIds = Array.isArray(body?.feedback)
    ? body.feedback.map(String).filter(Boolean)
    : undefined;
  const text = await reviews.buildAndMarkPrompt(c.req.param("id"), feedbackIds);
  return text != null ? c.text(text) : c.text("not found", 404);
});

// Which agents are blocked on `watch <id>` right now (drives the UI's
// Copy-vs-Submit affordance and the "who's watching" indicator).
app.get("/api/reviews/:id/watchers", (c) => c.json({ watchers: watchersOf(c.req.param("id")) }));

// The human hit "Submit": tell any watching agent to pick up the feedback now.
app.post("/api/reviews/:id/submit", (c) => {
  broadcast({ type: "submitted", reviewId: c.req.param("id") });
  return c.json({ ok: true });
});

// ---- feedback + replies ----
app.post("/api/reviews/:id/feedback", async (c) => {
  const body = await c.req.json().catch(() => null);
  // `file` is optional: general (review-level) feedback isn't tied to a path.
  if (!body?.body) return c.text("missing body", 400);
  const fb = await reviews.addFeedback(c.req.param("id"), body);
  if (!fb) return c.text("review not found", 404);
  if (reviews.isRejected(fb)) return c.text(fb.error, 400);
  return c.json(fb);
});

app.patch("/api/feedback/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.text("bad json", 400);
  // The status enum is two-valued and human-driven; reject anything else (e.g.
  // a stale client still sending the removed accepted/refuted verdicts) rather
  // than storing an unrenderable value.
  if (body.status !== undefined && body.status !== "open" && body.status !== "resolved")
    return c.text("bad status (open|resolved)", 400);
  const fb = reviews.editFeedback(c.req.param("id"), { body: body.body, status: body.status });
  return fb ? c.json(fb) : c.text("not found", 404);
});

app.patch("/api/feedback/:id/anchor", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.text("bad json", 400);
  const fb = await reviews.reanchorFeedback(c.req.param("id"), {
    file: body.file,
    lineStart: body.lineStart ?? null,
    lineEnd: body.lineEnd ?? null,
    quote: body.quote ?? null,
  });
  if (!fb) return c.text("not found", 404);
  if (reviews.isRejected(fb)) return c.text(fb.error, 400);
  return c.json(fb);
});

app.delete("/api/feedback/:id", (c) =>
  reviews.deleteFeedback(c.req.param("id")) ? c.json({ ok: true }) : c.text("not found", 404),
);

app.post("/api/feedback/:id/replies", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.body) return c.text("missing body", 400);
  const res = reviews.addReply(c.req.param("id"), body);
  if (!res) return c.text("not found", 404);
  if (reviews.isRejected(res)) return c.text(res.error, 400);
  return c.json(res);
});

// Edit a reply's prose (human fixing their own last message). Body only — the
// pin/anchor fields stay immutable.
app.patch("/api/replies/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.body !== "string" || !body.body.trim()) return c.text("missing body", 400);
  const rp = reviews.editReply(c.req.param("id"), body.body);
  return rp ? c.json(rp) : c.text("not found", 404);
});

// ---- live (SSE) ----
app.get("/api/events", (c) => {
  const filter = c.req.query("review");
  // A `watch` client passes ?session=<display> (+ optional ?agentId=<id>) so it
  // shows up as a live watcher on its review; browser tabs omit it and are not
  // counted.
  const session = c.req.query("session");
  const agentId = c.req.query("agentId") || undefined;
  return streamSSE(c, async (stream) => {
    // Serialize every write (event pushes + heartbeats) through one chain so
    // concurrent writeSSE calls can't interleave or race on the stream. Track the
    // queue depth: if a consumer's socket wedges, its writes stop resolving and
    // this chain — plus every JSON payload each `.then` retains — would grow
    // without bound as broadcasts keep arriving. Past a cap we tear down THIS
    // stream (abort → onAbort → cleanup) instead of dropping individual events;
    // dropping would silently desync the client's view, while a closed stream
    // just reconnects and re-syncs from a fresh detail fetch. Conservative:
    // 1000 queued writes is far more than a healthy loopback consumer ever holds.
    const MAX_PENDING = 1000;
    let pending = 0;
    let overflowed = false;
    let chain: Promise<unknown> = Promise.resolve();
    const send = (msg: { event: string; data: string }) => {
      if (overflowed) return chain;
      if (pending >= MAX_PENDING) {
        overflowed = true;
        // stream.abort() fires the onAbort subscribers (cleanup) and flips
        // stream.aborted, so the heartbeat loop exits too. Don't enqueue onto the
        // already-stuck chain.
        stream.abort();
        return chain;
      }
      pending++;
      chain = chain
        .then(() => stream.writeSSE(msg))
        .catch(() => {})
        .finally(() => {
          pending--;
        });
      return chain;
    };
    const unsub = subscribe((ev: ServerEvent) => {
      if (filter && "reviewId" in ev && ev.reviewId !== filter) return;
      // `file-changed` is scoped to the reviews whose watched files moved: a
      // filtered client (single review view / `r3 watch <id>`) drops it unless
      // its review is among them. An absent/empty list ⇒ keep broadcasting to all
      // (safe fallback); tabs without a filter are unaffected.
      if (
        filter &&
        ev.type === "file-changed" &&
        ev.reviewIds &&
        ev.reviewIds.length > 0 &&
        !ev.reviewIds.includes(filter)
      )
        return;
      send({ event: ev.type, data: JSON.stringify(ev) });
    });
    let watcherId: number | null = null;
    if (session && filter) {
      watcherId = addWatcher(filter, { session, agentId });
      broadcast({ type: "watchers-changed", reviewId: filter });
    }
    const cleanup = () => {
      unsub();
      if (watcherId != null && filter) {
        removeWatcher(filter, watcherId);
        broadcast({ type: "watchers-changed", reviewId: filter });
        watcherId = null;
      }
    };
    stream.onAbort(cleanup);
    // Heartbeat keeps the connection alive through proxies/idle timeouts.
    while (!stream.aborted) {
      await send({ event: "ping", data: "{}" });
      await stream.sleep(25000);
    }
    cleanup();
  });
});

// The SPA (its HTML shell, JS, CSS, favicon) is served natively by Bun.serve's
// `routes` (see startDaemon) from the `index` HTMLBundle — not through Hono. It
// carries no secrets (the token comes from the guarded /api/boot), so it needs
// no Host/token guard; every data + token endpoint stays behind Hono's /api/*
// guards. Unknown /api/* paths still 404 here rather than falling to the SPA.
app.all("/api/*", (c) => c.text("not found", 404));

// Is a *healthy* daemon already serving our port? Used to lose the lazy-spawn
// bind race gracefully (two CLI calls can both decide to spawn).
async function daemonAlreadyHealthy(): Promise<boolean> {
  const existing: DaemonInfo | null = readDaemonJson();
  if (!existing) return false;
  try {
    const r = await fetch(`${existing.url}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return r.ok && existing.pid !== process.pid;
  } catch {
    return false;
  }
}

// Start the daemon: take the start lock, bind the port, announce in daemon.json,
// watch files. Idempotent against a concurrent spawn — only the lock holder
// binds; everyone else exits 0 once the winner is healthy.
export async function startDaemon(): Promise<void> {
  if (!acquireDaemonLock()) {
    // Another spawn holds the start lock and will serve. Wait briefly for it to
    // become healthy so the CLI's poll succeeds, then step aside.
    for (let i = 0; i < 100; i++) {
      if (await daemonAlreadyHealthy()) break;
      await Bun.sleep(50);
    }
    process.exit(0);
  }

  // One-time: move legacy adhoc-doc files (docs/ -> scratch/) to match the row
  // conversion db.ts ran at import. Idempotent; runs only on the serving daemon.
  migrateLegacyDocFiles();
  // One-time (idempotent): snapshot legacy diff reviews into stored rounds.
  // Runs in the background — until a review converts, GET …/diff falls back to
  // rendering live from its refs.
  void reviews.migrateLegacyDiffReviews();
  // Housekeeping: drop expired session rows (an expired one is already rejected by
  // sessionExists; this just bounds table growth). Re-sweep periodically too — the
  // daemon runs for months and logins accrue over time. `.unref()` so the timer never
  // keeps the process alive on its own.
  db.deleteExpiredSessions();
  setInterval(() => db.deleteExpiredSessions(), 6 * 60 * 60 * 1000).unref();

  let server: ReturnType<typeof Bun.serve>;
  try {
    // `routes` serves the SPA natively (the HTMLBundle registers the shell at
    // /* plus its hashed /chunk-*.{js,css} + favicon assets); /api/* is routed
    // to Hono, whose Host/origin/token middleware runs there. Route specificity
    // puts /api/* above the /* SPA catch-all, and unmatched deep paths fall
    // through to the shell for client-side routing.
    //
    // development is gated on R3_DEV (only `bun run dev` / process-compose set
    // it): HMR must never turn on for a lazily-spawned daemon, whose cwd is an
    // arbitrary — possibly huge — repo that Bun's dev watcher would crawl and
    // exhaust fds on. reusePort:false so a foreign listener on the port is
    // a hard error, not a silent second bind (Bun defaults SO_REUSEPORT on).
    server = Bun.serve({
      port: PORT,
      hostname: BIND,
      reusePort: false,
      routes: {
        "/api/*": (req: Request) => app.fetch(req),
        "/*": index,
      },
      idleTimeout: 120,
      development: process.env.R3_DEV === "1" ? { hmr: true } : false,
    });
  } catch (err) {
    // Port taken by something we don't control. If it's a healthy daemon, that's
    // success from the caller's view; otherwise surface the bind error.
    releaseDaemonLock();
    if (await daemonAlreadyHealthy()) process.exit(0);
    throw err;
  }

  // daemon.json advertises the loopback URL: the CLI is always on-box (or reaches
  // us through an SSH forward to the same port). Printed review URLs use ORIGIN.
  writeDaemonJson({
    url: LOCAL_URL,
    port: PORT,
    pid: process.pid,
    token: TOKEN,
    version: R3_VERSION,
    // Record how we were actually launched (not how the CLI meant to launch us),
    // so `r3 status` can report the binary/command line serving this port — the
    // authoritative answer even for a hand-started `bun server/index.ts`.
    exec: process.execPath,
    argv: process.argv,
  });
  const stopWatcher = process.env.R3_NO_WATCH !== "1" ? startWatcher() : null;

  const shutdown = () => {
    stopWatcher?.();
    server.stop(true);
    // Only clear daemon.json if it's still ours (don't clobber a successor).
    if (readDaemonJson()?.pid === process.pid) removeDaemonJson();
    releaseDaemonLock();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  // A lazily-spawned daemon (R3_DETACHED, set by the CLI) shares the spawning
  // shell's process group, so ignore SIGINT — a terminal Ctrl-C during/after the
  // spawn window must not kill it; it's stopped via `r3 stop` (SIGTERM). A
  // directly-run `bun server/index.ts` keeps Ctrl-C → shutdown for dev.
  process.on("SIGINT", process.env.R3_DETACHED === "1" ? () => {} : shutdown);
  // Survive the controlling terminal closing (hangup), same reasoning.
  process.on("SIGHUP", () => {});

  console.log(`r3 daemon on ${ORIGIN}/  (v${R3_VERSION}, pid ${process.pid})`);
  console.log(`  token: ${TOKEN.slice(0, 8)}…  ·  bind: ${BIND}:${PORT}`);
}

// Run when invoked directly (`bun server/index.ts`). When imported by the CLI to
// spawn the daemon in-process, `import.meta.main` is false, so nothing serves.
if (import.meta.main) await startDaemon();
