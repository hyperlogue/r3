---
name: security-model
description: r3's full security posture — the Host/DNS-rebinding guard, the per-user token, same-origin rules on mutations, the quick-auth login-token→session-cookie gate and how REQUIRE_LOGIN is derived, remote access via ssh/tailscale, path + git-arg injection guards, and the dependency cooldown. Use when touching auth.ts, config.ts, the route guards in server/index.ts, anything about binding/ports/exposure/R3_* env vars or config.json, exposing r3 beyond loopback, reverse proxies, login tokens, or reviewing a change for security impact.
---

# r3's security model

This file is the **design source of truth** for r3's security posture — update it
here when the posture changes. `AGENTS.md` carries only the one-line invariants;
the reasoning lives here.

The threat model r3 actually defends: **browser-borne attack** (DNS rebinding,
cross-origin `fetch`) and **casual remote access**. It explicitly does *not*
defend against other local UIDs — see "What this does not protect" below.

## Artifact API boundary (pending client cutover)

`server/artifact-auth.ts` is the injected guard for the artifact protocol. The
legacy routes below remain in use until the daemon and clients switch together.
The artifact guard compares full application origins, including the port; an
allowed hostname alone no longer authorizes a browser origin. Explicit configured
application origins support a proxy that rewrites Host. Preview origins must
never enter that set. Browser requests carrying cross-origin Fetch Metadata do
not acquire the no-Origin local CLI exemption.

Every artifact data stream requires token or cookie authentication, including
SSE. Browser and agent clients use authenticated fetch streams, removing the
legacy token-free EventSource exception. Health, same-origin boot, and login
retain their narrow bootstrap roles. Required-login boot exposes no master
token; login and revocation retain `AuthService`'s existing cookie contract.

Application-origin resource downloads are attachments with a restrictive CSP,
`nosniff`, and same-origin resource policy (`server/artifact-resources.ts`).
Executable preview responses require their separate isolated-origin policy.

### Preview host (pending daemon/client cutover)

`server/preview-host.ts` serves one published version per temporary random
subdomain. `PreviewContexts` validates the exact host and port, expires contexts
after one hour without application renewal, and revokes their browser grants
together. It never transfers the application's token or cookies. Every published
resource requires a preview-only Secure, HttpOnly, partitioned cookie.

Before issuing that cookie, an r3-owned gate checks an allowed same-origin fetch,
the blocking of another working same-origin endpoint, and WebRTC policy rejection
with no ICE servers and relay-only transport. That WebRTC check emits no probe
packets. The gate then exchanges a single-use challenge through a same-origin
JSON POST. A foreign page cannot forge its Origin or read its challenge through
CORS. Grants bind to the browser's user-agent/client-hint identity, so copying a
preview URL, or reusing a cookie in a different browser version, does not skip
verification. User-agent detection alone never enables rendering.

Chromium omits client hints on worker scripts and worker fetches. Those resource
requests may use a verified cookie with the same User-Agent when both hints are
absent. A document/iframe navigation still requires the complete identity from
the gate. This permits native workers without turning a copied cookie into an
unverified executable-document grant.

The preview's Connection Allowlist includes only its `/files/*` and `/r3/*`
namespaces, with WebRTC and redirects blocked. CSP additionally restricts resource
classes, forms, frames, and navigation through sandboxing. Service-worker script
requests are refused: a worker must not substitute a document response without
the server's policy. Ordinary published workers still receive the policy.
Camera/microphone are delegated through the isolated real origin and retain
browser consent. Neither permission grants a network exception.

Preview documents are not cached; the response inserts the r3 runtime before
publisher scripts in original HTML or retained Markdown HTML without changing
stored bytes. Native resource
GET/HEAD/range responses remain private and immutable, varying by preview cookie,
browser identity, and fetch destination. Unknown paths never receive a document
fallback or an upstream proxy response.

The real host/gate loaded published scripts and JSON in Chrome for Testing 153,
and refused Chromium 151 before any published file request. The full Chrome 153
build passed the network/device matrix in `scripts/test-preview-isolation.ts`:
native resources and audio seeking, workers and blob workers, denied service
workers, external resources/connections/WebTransport, redirects, direct and nested
navigation, document rewriting, same-host application/version isolation, and
WebRTC with a controlled UDP sink. Browser permission denial rejects media capture;
grant enables fake audio/video devices without enabling WebRTC packets. Tests
use a fresh profile and controlled loopback endpoints; no physical device is read.
The integrated artifact workspace
has also passed real-browser tests for human utility messages, shared threads,
version switching, original rendered Locate, and native document navigation.

The parent accepts bridge messages only from its exact iframe window, preview
origin, and context id. The bridge exposes context, same-artifact conversations,
human feedback/replies, explicit Submit, and change notifications. It has no
generic HTTP or host-command operation and accepts no actor or version override.
Mutations require browser user activation; page load and agent replies cannot
silently send another message or handoff. Published path membership is checked
before dispatch, reply ids must belong to the same artifact, and the server
validates each native target. Application authentication stays in the parent.

## The bind

Binds **`127.0.0.1`** by default. `R3_BIND` overrides it, and that is an explicit
opt-in with consequences (it arms the login gate — below). **Never bind `0.0.0.0`.**

## Layer 1 — the Host guard (DNS-rebinding defense)

Every request **that returns data or the token** — i.e. all of `/api/*`, including
`/api/boot` — must carry a **Host** that is one of:

- loopback,
- an allowlisted name (`R3_ALLOWED_HOSTS`, exact names, **never `*`**), or
- the **advertised public host**, derived from `R3_PUBLIC_URL` and allowed
  implicitly (`config.ts`) — since r3 hands that URL out, it must resolve. This is
  why a single `R3_PUBLIC_URL=https://<name>` is enough for `tailscale serve`, with
  no separate `R3_ALLOWED_HOSTS` for the common one-host case.

The **static SPA shell + hashed JS/CSS/favicon** are served natively by
`Bun.serve`'s `routes`, *outside* this Hono guard. That's fine: they carry no
secrets and grant no capability — the app is inert until the Host-gated
`/api/boot` bootstraps it. **Never let a data/token endpoint out from behind the
guard.**

## Layer 2 — token or session cookie on every data endpoint

**Every `/api` data endpoint requires the per-user token _or_ a valid session
cookie** (`resolveAuth`) — reads as well as writes.

Always token-free (still Host-gated):

| Route | Extra gate |
| --- | --- |
| `/api/health` | — |
| `/api/boot` | same-origin |
| `/api/auth/login` | same-origin (you have no session yet) |
| `/api/events` | **only while `REQUIRE_LOGIN` is off** |

`/api/events` is the subtle one: EventSource can't set headers, so SSE goes
token-free while login isn't required. Once `REQUIRE_LOGIN` is on, a session
cookie rides EventSource and it's gated like any read. Note the condition is
`REQUIRE_LOGIN`, **not** "exposed" — there is no `EXPOSED` predicate, and
`R3_REQUIRE_LOGIN=0` on an exposed daemon leaves SSE open.

**Mutating routes** (POST/PUT/PATCH/DELETE) additionally require **same-origin**.
`sameOrigin()` deliberately dropped the port pin — so a forward/proxy that changes
the port still passes — and leans on the Host allowlist + token/cookie instead.

## Layer 3 — quick-auth (login token → session cookie)

`AuthService` in `server/auth.ts` owns token/session persistence and hashing on an
injected SQLite connection. Importing it opens no database. Legacy and artifact
bootstrap use the same hash-only auth table shapes, preserving login state during
the storage migration. Revocation updates the token and removes its sessions in
one transaction; session minting checks that its token is still active.

An **optional login gate**, pure hardening, on the zellij model (`server/auth.ts`),
gated by ONE startup policy: **`REQUIRE_LOGIN`** (`config.ts`).

It is a *login policy*, not a detected fact. r3 **cannot** tell a truly-local
client from a proxied one (a reverse proxy rewrites `Host`/`Origin`), so it is
decided once at startup and defaults **on whenever any non-loopback access is
configured**:

- a non-loopback (or wildcard) bind,
- a non-loopback `R3_PUBLIC_URL`, or
- any non-loopback `R3_ALLOWED_HOSTS` name.

Allowing a remote Host *is itself* the signal. `R3_REQUIRE_LOGIN` (1/0) forces it
either way.

**Login not required** (the default): the daemon binds loopback, every client is
already local, so `/api/boot` hands the same-origin page the per-user token — no
login, unchanged.

**Login required**: the web UI wants a **login token** (`r3 auth create-token`,
hashed at rest, shown once, revocable) for *every* session, including the
operator's own localhost. `/api/boot` returns `401 { needsAuth }` until
`/api/auth/login` trades the token for an **HttpOnly, SameSite=Strict** cookie
(Secure when the edge is HTTPS, read from `X-Forwarded-Proto`). The **master token
never reaches a browser** when login is required — it's cookie-only. Revoking a
login token deletes its sessions immediately. The per-user token stays the CLI's
credential, unaffected.

**Revoking your own token is refused** (`409`): `GET /api/auth/tokens` flags the
caller's own token (the one behind its session cookie) `current:true` so the UI
disables its revoke, and `DELETE …/:id` refuses it — revoking would delete the
caller's live session and lock them out mid-request. A master-token caller carries
no cookie, so nothing is `current`. Bulk `DELETE …/tokens` (revoke-all) is the
deliberate escape hatch and isn't guarded.

### The reverse-proxy blind spot

`REQUIRE_LOGIN`'s default is derived from r3's own bind + advertised host, so a
proxy that forwards `Host: 127.0.0.1` (nginx's default `proxy_pass`) reads as
loopback-only — and `/api/boot` would hand a remote browser the per-user token. r3
can't see the real client name, and a naive proxy sends no `X-Forwarded-*` to key
off either.

**Any roll-your-own reverse-proxy deployment must set `R3_REQUIRE_LOGIN=1`** (or
point `R3_PUBLIC_URL`/`R3_ALLOWED_HOSTS` at the public name, which arms the gate).
`tailscale serve` forwards the real Host, so `R3_PUBLIC_URL` alone covers it.

## Persisting the posture

The exposure knobs — `R3_BIND`, `R3_PORT`, `R3_PUBLIC_URL`, `R3_ALLOWED_HOSTS`,
`R3_REQUIRE_LOGIN` — can be **persisted** in `$XDG_CONFIG_HOME/r3/config.json` via
`r3 config set`. Each is resolved **`env ?? config.json ?? default`**, so the file
is a durable fallback that keeps a remote-serving daemon exposed across restarts
and lazy-spawns; env still wins for a one-off run, and a one-off env value is
never auto-persisted. The file carries **no secret**.

Because `config.json` values feed the same derivation, persisting
`publicUrl`/`allowedHosts` **re-arms the `REQUIRE_LOGIN` default on restart** — a
persisted remote posture never silently drops its login gate.

Always persist it once rather than relying on the env of whatever shell happened
to spawn the daemon:

```sh
r3 config set publicUrl https://<magicdns-name>
r3 config set requireLogin 1
```

## Remote access

Two supported shapes, both keeping the daemon on loopback:

- **`ssh -L 8791:localhost:8791`** — you browse `localhost`, so the daemon isn't
  exposed and `REQUIRE_LOGIN` stays off: zero friction, no login.
- **`tailscale serve`** — preferred over binding the tailnet IP, so TLS terminates
  at Tailscale and identity headers stay available for future per-user auth. Set
  `R3_PUBLIC_URL=https://<magicdns-name>` (which auto-allows that Host **and** arms
  the login gate) and `r3 auth create-token`; browsers log in with that token.

## Input guards

- **Path inputs** are validated against the requesting review's **worktree** root
  (or the scratch root for `SCRATCH`) — repo-relative, no `..`, no absolute
  (`server/paths.ts` `safePathIn`, reached through `repo.safePath()`).
- **Git arg-injection**: reject **refs** beginning with `-` before they reach git
  (`isSafeRef` in `server/git.ts`) — an option like `--output=<file>` would write a
  file. Paths are guarded by `safePathIn` and reach git only behind a `--`
  separator or as a `ref:path` spec; keep it that way at any new call site.
- **Agent inbox sockets** (`r3 listen`, `server/inbox.ts`): the request hands the
  daemon a filesystem path it will later connect to and write to. The API is
  already token- and same-origin gated, so the caller is trusted — but "the daemon
  opens an arbitrary path on request" is a primitive worth not having.
  `validateSocketPath` requires an absolute `.sock`, no null byte, a parent
  directory matching the harness's documented per-user socket dirs, and — after
  `statSync` resolves the link chain — a real socket owned by our own uid. Shape
  is checked before touching the disk, so the interesting rules stay testable.
- **Codex queue targets** (`r3 listen`, `server/listener.ts`): the request hands
  the daemon a thread id and human-authored prose that later reach a child
  process. Both are passed to a fixed `codex queue` executable as separate argv
  values, never through a shell; the API accepts no executable path or extra
  flags. Thread ids are non-empty, null-free and capped at 200 characters. The
  queue command is killed after 10 seconds, and a non-zero exit is failed
  delivery, so the listener is dropped rather than left looking live. Before
  registration, the daemon uses that same bounded command seam to run `codex
  queue --help`; missing support returns `501` instead of leaving capability to a
  short-lived CLI process with a potentially different environment.

## Claude Code's session token (`r3 listen`)

`r3 listen` reads `CLAUDE_CODE_MESSAGING_TOKEN` from its own environment (the
harness exports it to every child of a session) and POSTs it to the daemon, which
presents it on the auth line when pushing a nudge. It is what marks the push as
the session's own tooling rather than an unattributed peer.

**It is required, and refused twice**: the CLI exits `5` when the env var is
absent (the same "can't be messaged, use `r3 watch`" answer as a harness with no
inbox), and `POST …/listen` answers `400 missing token` for a caller that skips
it. The alternative — pushing unattributed and hoping — is a coin flip on whether
the daemon happens to descend from that session, resolved silently in the failure
direction (below).

**It is a live session credential and never reaches the store.** The listener
registry is in-memory (`server/watchers.ts`) *because* of this; Codex targets
share its lifecycle rather than introducing a second persistence model. That is
the reason a daemon restart drops every registration, not an accident of the
design.
Do not add a `listeners` table, and do not log the token. Its blast radius is
bounded anyway: it dies with its session, and anyone who can read r3's sqlite can
already read `$XDG_STATE_HOME/r3/token` and drive the whole daemon.

Measured, not assumed: a non-descendant process sending **no** auth line has its
message **held for approval** by a `bypassPermissions` session, and — because r3
supplies no reply address — cannot even be told that it was held. So a session
whose inbound policy holds our push is indistinguishable to r3 from one that read
it. That measurement is the reason the token is mandatory: descent is the only
other attribution the wire offers, and one per-user daemon spans every session
while descending from at most one of them.

**The authenticated case is measured too, and it is delivered.** A live daemon
reparented to init (ppid 1, so a non-descendant of the session by construction)
pushed a Submit nudge with the auth line into a session running the *default*
inbound policy, and it arrived — no approval hold. So attribution, not descent, is
what the harness gates on, and `crossSessionInbound: "accept"` is **not** a
requirement for unattended agents as long as the token is presented. Since the
token is mandatory, that is the only way r3 pushes at all.

## What this does *not* protect

**Other local UIDs.** `/api/boot`'s same-origin check passes any request with no
`Origin` header (as `curl` sends none), so while the daemon isn't exposed, any
local process of any UID can fetch the token. This is the intentional local-trust
boundary, not an oversight — a real per-UID boundary needs an OS-level
peer-credential check.

## Dependency cooldown (supply chain)

A new package version is adopted only after a **3-week** minimum age, on both
update paths:

- `bun`'s `minimumReleaseAge` (`bunfig.toml`, in **seconds** — 1814400) gates every
  local `bun install`/`add`/`update`;
- a matching Dependabot `cooldown` (`default-days: 21`, `.github/dependabot.yml`)
  gates bot PRs.

So a freshly-published compromised release can't be pulled in before it's had time
to be caught. Cooldown covers **version updates only** — Dependabot *security*
updates bypass it so a real fix isn't held back. **Never disable or lower the
cooldown to land a dependency**; if a needed version is younger than 21 days, stop
and say so.
