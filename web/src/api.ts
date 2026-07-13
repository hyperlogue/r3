// Typed client for the r3 HTTP API. The per-user token is fetched once from the
// guarded `GET /api/boot` endpoint before first render (see loadBoot); the token
// is sent on every request — the server token-gates GET reads too, not just
// mutations. The token is deliberately NOT baked into the served
// HTML — that keeps the SPA shell a cacheable, embeddable static asset and the
// token same-origin-only.

import type {
  AddReplyBody,
  AuthTokenInfo,
  BootResponse,
  CreateAuthTokenBody,
  CreateAuthTokenResponse,
  CreateFeedbackBody,
  CreateReviewBody,
  DiffResult,
  Feedback,
  FeedbackStatus,
  GitLogEntry,
  GitStatus,
  GitTreeEntry,
  LoginBody,
  ReanchorBody,
  RenderedFile,
  Reply,
  RepoRecord,
  Review,
  ReviewDetail,
  ReviewDiffResponse,
  SetViewedBody,
  SnapshotDiffResponse,
  SnapshotMeta,
  SnapshotRef,
  ThemeOption,
  ThemeStyle,
  UpdateReplyBody,
  UpdateReviewBody,
  ViewedResponse,
  WatchersResponse,
} from "./types.ts";

// Populated by loadBoot() before the app renders (main.tsx awaits it). A
// module-level live binding, so `req()` below reads the real token at call time.
// Empty when the browser authenticates by session cookie alone (any remote login),
// so the master token never leaves the box — `req()` then relies on the cookie.
export let TOKEN = "";

// Bootstrap before first render. When the daemon isn't exposed it returns the
// per-user token (sent as x-r3-token below); when exposed it needs a login-token
// session and answers 401 `{ needsAuth:true }`, and the caller shows the login screen.
export async function loadBoot(): Promise<{ needsAuth: boolean }> {
  const r = await fetch("/api/boot");
  // 401 = a remote origin with no valid session. Not an error — the signal to log in.
  if (r.status === 401) {
    const b = (await r.json().catch(() => ({}))) as Partial<BootResponse>;
    return { needsAuth: b.needsAuth ?? true };
  }
  if (!r.ok) throw new Error(`GET /api/boot → ${r.status}`);
  const b = (await r.json()) as BootResponse;
  if (b.needsAuth) return { needsAuth: true };
  TOKEN = b.token ?? "";
  return { needsAuth: false };
}

// An HTTP error from `req()`, carrying the response `status` so callers can react
// to a specific code (e.g. ReviewView treats a 404 as "the review was deleted"
// and stops preferring its stale cached detail).
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
  // git browsing — `repo` selects which registered project to browse;
  // omitted = the daemon's default repo.
  status: (repo?: string) => req<GitStatus>("GET", `/api/git/status${qs({ repo })}`),
  log: (limit = 60, cursor = 0, repo?: string) =>
    req<GitLogEntry[]>("GET", `/api/git/log${qs({ limit, cursor, repo })}`),
  tree: (ref = "HEAD", path?: string, repo?: string) =>
    req<GitTreeEntry[]>("GET", `/api/git/tree${qs({ ref, path, repo })}`),

  // projects registry
  repos: () => req<RepoRecord[]>("GET", "/api/repos"),
  relinkRepo: (id: string, path: string) =>
    req<RepoRecord>("POST", `/api/repos/${id}/relink`, { path }),
  renameRepo: (id: string, name: string) => req<RepoRecord>("PATCH", `/api/repos/${id}`, { name }),
  forgetRepo: (id: string) => req<{ ok: true }>("DELETE", `/api/repos/${id}`),
  diff: (
    base: string,
    head: string,
    opts: {
      ignoreWhitespace?: boolean;
      contextLines?: number;
      theme?: string;
      review?: string;
    } = {},
  ) =>
    req<DiffResult>(
      "GET",
      `/api/diff${qs({ base, head, ignoreWhitespace: opts.ignoreWhitespace ? 1 : undefined, contextLines: opts.contextLines, theme: opts.theme, review: opts.review })}`,
    ),
  // A diff review's rendered content: its stored rounds in seq order (a legacy
  // review with no stored rounds renders live from its refs as seq 0).
  reviewDiff: (id: string, theme?: string) =>
    req<ReviewDiffResponse>("GET", `/api/reviews/${id}/diff${qs({ theme })}`),
  // `review` ties the request to a review's repo/worktree so its content resolves
  // against the right project — the daemon is multi-repo.
  blob: (path: string, ref = "WORKING", theme?: string, review?: string) =>
    req<RenderedFile>("GET", `/api/blob${qs({ path, ref, theme, review })}`),

  // Files-review content snapshots. `snapshotDiff` derives the diff
  // between two snapshot refs (from a seq; to a seq or "WORKING"=live);
  // `snapshotBlob` renders one file at a snapshot ref (the from=None browse mode).
  snapshots: (id: string) => req<SnapshotMeta[]>("GET", `/api/reviews/${id}/snapshots`),
  snapshotDiff: (id: string, from: number, to: SnapshotRef, theme?: string) =>
    req<SnapshotDiffResponse>("GET", `/api/reviews/${id}/snapshot-diff${qs({ from, to, theme })}`),
  snapshotBlob: (id: string, path: string, to: SnapshotRef, theme?: string) =>
    req<RenderedFile>("GET", `/api/reviews/${id}/snapshot-blob${qs({ path, to, theme })}`),

  // Syntax-theme options (curated families + all bundled Shiki themes).
  themes: () => req<ThemeOption[]>("GET", "/api/themes"),
  // The selected theme's editor background + default foreground, painted onto the
  // code surfaces so a theme (e.g. Nord) looks like it does in an editor.
  themeStyle: (theme?: string) => req<ThemeStyle>("GET", `/api/theme-style${qs({ theme })}`),

  // reviews
  listReviews: (filter: { session?: string; status?: string; repo?: string } = {}) =>
    req<Review[]>("GET", `/api/reviews${qs(filter)}`),
  createReview: (body: CreateReviewBody, repo?: string) =>
    req<{ id: string; url: string; review: Review }>("POST", `/api/reviews${qs({ repo })}`, body),
  review: (id: string) => req<ReviewDetail>("GET", `/api/reviews/${id}`),
  patchReview: (id: string, body: UpdateReviewBody) =>
    req<Review>("PATCH", `/api/reviews/${id}`, body),
  deleteReview: (id: string) => req<{ ok: true }>("DELETE", `/api/reviews/${id}`),
  // The unsent-only prompt, previewed WITHOUT marking it delivered — a GET so it
  // has no side effects. Used to fetch the text to copy first; only a landed
  // clipboard write then calls `prompt` (below) to stamp sent_at, so a failed
  // copy leaves the unsent set intact for a retry (see useCopyPrompt).
  promptPreview: (id: string) =>
    req<string>("GET", `/api/reviews/${id}/prompt${qs({ scope: "unsent" })}`),
  // The unsent-only prompt: builds only what the agent hasn't seen and marks it
  // delivered, so it's a POST (it mutates sent_at). Full-history
  // re-prints are CLI-only (`r3 prompt --all`), never surfaced in the browser.
  prompt: (id: string) => req<string>("POST", `/api/reviews/${id}/prompt`, {}),
  watchers: (id: string) => req<WatchersResponse>("GET", `/api/reviews/${id}/watchers`),
  submit: (id: string) => req<{ ok: true }>("POST", `/api/reviews/${id}/submit`),

  // Per-reviewer viewed-state. Server-persisted read-progress;
  // keys are opaque content-identity tokens (see viewed.ts). GET returns the set;
  // PUT sets/clears one key. No SSE — a second tab reconciles on refetch.
  getViewed: (id: string) =>
    req<ViewedResponse>("GET", `/api/reviews/${id}/viewed`).then((r) => new Set(r.keys)),
  setViewed: (id: string, key: string, viewed: boolean) =>
    req<{ ok: true }>("PUT", `/api/reviews/${id}/viewed`, { key, viewed } satisfies SetViewedBody),

  // feedback + replies
  addFeedback: (reviewId: string, body: CreateFeedbackBody) =>
    req<Feedback>("POST", `/api/reviews/${reviewId}/feedback`, body),
  editFeedback: (id: string, body: { body?: string; status?: FeedbackStatus }) =>
    req<Feedback>("PATCH", `/api/feedback/${id}`, body),
  reanchor: (id: string, body: ReanchorBody) =>
    req<Feedback>("PATCH", `/api/feedback/${id}/anchor`, body),
  deleteFeedback: (id: string) => req<{ ok: true }>("DELETE", `/api/feedback/${id}`),
  addReply: (feedbackId: string, body: AddReplyBody) =>
    req<{ reply: Reply; feedback: Feedback }>("POST", `/api/feedback/${feedbackId}/replies`, body),
  editReply: (id: string, body: UpdateReplyBody) => req<Reply>("PATCH", `/api/replies/${id}`, body),

  // auth (quick-auth: login token -> session cookie). login() is the only call
  // that runs before a session exists; the rest manage login tokens and require auth
  // (the per-user token, or a valid session cookie).
  login: (token: string) =>
    req<{ ok: true }>("POST", "/api/auth/login", { token } satisfies LoginBody),
  logout: () => req<{ ok: true }>("POST", "/api/auth/logout"),
  authTokens: () => req<AuthTokenInfo[]>("GET", "/api/auth/tokens"),
  createAuthToken: (body: CreateAuthTokenBody) =>
    req<CreateAuthTokenResponse>("POST", "/api/auth/tokens", body),
  revokeAuthToken: (id: string) => req<{ ok: true }>("DELETE", `/api/auth/tokens/${id}`),
};
