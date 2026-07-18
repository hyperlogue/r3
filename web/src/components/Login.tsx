import { type FormEvent, useState } from "react";
import { ApiError, api } from "../api.ts";
import { Button } from "../ui.tsx";
import { Logo } from "./Logo.tsx";

// The login screen shown when login is required (server/config.ts REQUIRE_LOGIN, e.g.
// `tailscale serve`) and there's no valid session yet. The user pastes a login token
// minted on the host with `r3 auth create-token`; POST /api/auth/login sets an
// HttpOnly session cookie, and we reload so boot re-runs — now authenticated — and
// renders the app. A loopback-only daemon (no login required) never reaches this:
// /api/boot hands the page the per-user token instead.
export function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(value);
      location.reload(); // re-boot with the session cookie -> the app
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That login token is invalid or has been revoked."
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-50 px-6 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-neutral-300 bg-white p-6 shadow-sm dark:border-neutral-700 dark:bg-neutral-950"
      >
        <div className="mb-4 flex items-center gap-2">
          <Logo className="size-6" />
          <span className="text-lg font-semibold">r3</span>
        </div>
        <h1 className="mb-1 text-sm font-semibold">Sign in</h1>
        <p className="mb-4 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          This r3 server is reachable over the network, so it needs a login token. Create one on the
          host with{" "}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.7rem] dark:bg-neutral-800">
            r3 auth create-token
          </code>{" "}
          and paste it below.
        </p>
        <input
          type="password"
          // biome-ignore lint/a11y/noAutofocus: single field on a dedicated screen
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="r3tok_…"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          // max-md:text-base keeps iOS from zooming the login screen on focus.
          className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary-400 max-md:text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
        {error && <p className="mt-2 text-xs text-danger-600 dark:text-danger-500">{error}</p>}
        <Button
          type="submit"
          variant="primary"
          disabled={!token.trim() || busy}
          className="mt-4 w-full justify-center py-1.5"
        >
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
