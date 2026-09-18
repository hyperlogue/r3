// Application bootstrap, theme settings, and login-token access.
// Artifact operations use artifact-api.ts and the shared ArtifactClient.

import { markdownCache } from "./markdown-cache.ts";
import type {
  AuthTokenInfo,
  BootResponse,
  CreateAuthTokenBody,
  CreateAuthTokenResponse,
  LoginBody,
  ThemeOption,
  ThemeStyle,
} from "./types.ts";

// Populated by loadBoot() before the app renders (main.tsx awaits it). A
// module-level live binding, so `req()` below reads the real token at call time.
// Empty when the browser authenticates by session cookie alone (any remote login),
// so the master token never leaves the box — `req()` then relies on the cookie.
export let TOKEN = "";

// Whether this build can mint login tokens for remote access. Always true against
// a daemon; the browser demo aliases this module and sets it false (there is no
// daemon to expose beyond loopback, so the settings popup drops the whole "Access"
// section rather than offering a control that can only fail).
export const CAN_MANAGE_TOKENS = true;

// Bootstrap before first render. When the daemon isn't exposed it returns the
// per-user token (sent as x-r3-token below); when exposed it needs a login-token
// session and answers 401 `{ needsAuth:true }`, and the caller shows the login screen.
export async function loadBoot(): Promise<{ needsAuth: boolean }> {
  const cacheEpoch = await markdownCache.authenticationEpoch();
  const r = await fetch("/api/boot");
  // 401 = a remote origin with no valid session. Not an error — the signal to log in.
  if (r.status === 401) {
    await markdownCache.suspend();
    const b = (await r.json().catch(() => ({}))) as Partial<BootResponse>;
    return { needsAuth: b.needsAuth ?? true };
  }
  if (!r.ok) throw new Error(`GET /api/boot → ${r.status}`);
  const b = (await r.json()) as BootResponse;
  if (b.needsAuth) {
    await markdownCache.suspend();
    return { needsAuth: true };
  }
  TOKEN = b.token ?? "";
  await markdownCache.resume(cacheEpoch);
  return { needsAuth: false };
}

// An HTTP error from `req()`, carrying the response `status` so callers can react
// to a specific code (e.g. authentication controls distinguish an expired session).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Loopback boot hands us the token; a remote session authenticates by the
  // HttpOnly cookie (sent automatically same-origin), so only add the header when we
  // actually hold a token — an empty x-r3-token would just fail the constant-time compare.
  if (TOKEN) headers["x-r3-token"] = TOKEN;
  const r = await fetch(path, {
    method,
    redirect: "error",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ApiError(r.status, `${method} ${path} → ${r.status}: ${await r.text()}`);
  const ct = r.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? r.json() : r.text()) as Promise<T>;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const api = {
  themes: () => req<ThemeOption[]>("GET", "/api/themes"),
  themeStyle: (theme?: string) => req<ThemeStyle>("GET", `/api/theme-style${qs({ theme })}`),
  // auth (quick-auth: login token -> session cookie). login() is the only call
  // that runs before a session exists; the rest manage login tokens and require auth
  // (the per-user token, or a valid session cookie).
  login: (token: string) =>
    req<{ ok: true }>("POST", "/api/auth/login", { token } satisfies LoginBody),
  logout: async () => {
    try {
      return await req<{ ok: true }>("POST", "/api/auth/logout");
    } finally {
      await markdownCache.suspend();
    }
  },
  authTokens: () => req<AuthTokenInfo[]>("GET", "/api/auth/tokens"),
  createAuthToken: (body: CreateAuthTokenBody) =>
    req<CreateAuthTokenResponse>("POST", "/api/auth/tokens", body),
  revokeAuthToken: (id: string) => req<{ ok: true }>("DELETE", `/api/auth/tokens/${id}`),
};
