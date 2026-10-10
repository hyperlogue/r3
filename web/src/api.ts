import { draftImages } from "./attachment-drafts.ts";
// Application bootstrap, theme settings, and login-token access.
// Artifact operations use artifact-api.ts and the shared ArtifactClient.

import { markdownCache } from "./markdown-cache.ts";
import { clearPreviewResumeHints } from "./preview-resume.ts";
import type {
  ApplicationBootstrap,
  ArtifactDetail,
  AuthTokenInfo,
  BootResponse,
  CreateAuthTokenBody,
  CreateAuthTokenResponse,
  LoginBody,
  ThemeOption,
  ThemeStyle,
} from "./types.ts";

// Populated by loadBoot() before rendering. Shipped local and remote servers use
// HttpOnly session cookies and leave this empty. Token-bearing bootstrap remains
// supported only for controlled fixtures and the static demo.
export let TOKEN = "";

// The server supports browser login-token management. The static demo aliases
// this module and disables its Access controls because it has no server.
export const CAN_MANAGE_TOKENS = true;

// Bootstrap before first render. Local one-time links and remote login both
// establish an HttpOnly browser session before accessing application data.
export async function loadBoot(initial?: ApplicationBootstrap): Promise<{
  needsAuth: boolean;
  artifact?: ArtifactDetail;
  manifest?: ApplicationBootstrap["manifest"];
  preview?: ApplicationBootstrap["preview"];
}> {
  if (location.hash.startsWith("#r3-login=")) {
    const ticket = location.hash.slice("#r3-login=".length);
    // Clear the one-time fragment before any application rendering or requests.
    history.replaceState(history.state, "", location.pathname + location.search);
    const response = await fetch("/api/auth/local", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (!response.ok)
      throw new Error("Local browser link expired or was already used. Run r3 open again.");
    initial = undefined;
  }
  if (initial) {
    const suspended = await Promise.all([
      markdownCache.authenticationSuspended(),
      draftImages.authenticationSuspended(),
    ]);
    if (!suspended.some(Boolean)) {
      TOKEN = initial.boot.token ?? "";
      // The HTML request preceded our cache reads. Never resume a cache from
      // this snapshot: logout may have raced the document or its bundle load.
      return {
        needsAuth: false,
        ...(initial.artifact
          ? { artifact: initial.artifact, manifest: initial.manifest, preview: initial.preview }
          : {}),
      };
    }
  }
  const cacheEpoch = await markdownCache.authenticationEpoch();
  const imageEpoch = await draftImages.epoch();
  const r = await fetch("/api/boot");
  // 401 means no valid browser session, locally or remotely: show login.
  if (r.status === 401) {
    await markdownCache.suspend();
    await draftImages.clear();
    const b = (await r.json().catch(() => ({}))) as Partial<BootResponse>;
    return { needsAuth: b.needsAuth ?? true };
  }
  if (!r.ok) throw new Error(`GET /api/boot → ${r.status}`);
  const b = (await r.json()) as BootResponse;
  if (b.needsAuth) {
    await markdownCache.suspend();
    await draftImages.clear();
    return { needsAuth: true };
  }
  TOKEN = b.token ?? "";
  await markdownCache.resume(cacheEpoch);
  await draftImages.resume(imageEpoch);
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
  // Normal browser requests use the same-origin HttpOnly cookie. Only controlled
  // token-bearing bootstraps need this compatibility header.
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
  inspectClientAuthorization: (userCode: string) =>
    req<{ label: string | null; expiresAt: number; requestIp: string | null }>(
      "POST",
      "/api/oauth/device/inspect",
      { userCode },
    ),
  decideClientAuthorization: (userCode: string, approved: boolean) =>
    req<{ ok: true }>("POST", "/api/oauth/device/decision", { userCode, approved }),
  themes: () => req<ThemeOption[]>("GET", "/api/themes"),
  themeStyle: (theme?: string) => req<ThemeStyle>("GET", `/api/theme-style${qs({ theme })}`),
  // Browser login exchanges a login token for a session cookie. Management calls
  // require authentication; local ticket exchange is handled by loadBoot().
  login: (token: string) =>
    req<{ ok: true }>("POST", "/api/auth/login", { token } satisfies LoginBody),
  logout: async () => {
    try {
      return await req<{ ok: true }>("POST", "/api/auth/logout");
    } finally {
      clearPreviewResumeHints();
      await markdownCache.suspend();
      await draftImages.clear();
    }
  },
  authTokens: () => req<AuthTokenInfo[]>("GET", "/api/auth/tokens"),
  createAuthToken: (body: CreateAuthTokenBody) =>
    req<CreateAuthTokenResponse>("POST", "/api/auth/tokens", body),
  revokeAuthToken: (id: string) => req<{ ok: true }>("DELETE", `/api/auth/tokens/${id}`),
};
