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
