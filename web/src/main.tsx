import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadBoot } from "./api.ts";
import { Login } from "./components/Login.tsx";
import { clampFont } from "./settings.ts";
import "./main.css";

// Restore the saved theme before first paint.
const savedTheme = localStorage.getItem("r3-theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
if (savedTheme === "dark" || (savedTheme == null && prefersDark)) {
  document.documentElement.classList.add("dark");
}
// Clamp/validate here too: the store's clampFont only runs inside get/set, not on
// this raw boot read, so a corrupt or out-of-range stored value would otherwise be
// applied verbatim at first paint. Ignore non-numeric values (leave the CSS default).
const savedFont = Number(localStorage.getItem("r3-font-size"));
if (Number.isFinite(savedFont) && savedFont > 0) {
  document.documentElement.style.setProperty("--r3-font-size", `${clampFont(savedFont)}px`);
}

// Fetch the token before rendering — every mutating request needs it. Served by
// the daemon, so on a normal load this is an instant loopback round-trip. If it
// fails (daemon down / unreachable), paint a fallback instead of an empty #root.
async function main() {
  let boot: { needsAuth: boolean };
  try {
    boot = await loadBoot();
  } catch (err) {
    renderBootError(err);
    return;
  }

  const root = createRoot(document.getElementById("root")!);

  // A remote origin with no session: render the login screen. On success it reloads,
  // so boot re-runs (now with a session cookie) and falls through to the app.
  if (boot.needsAuth) {
    root.render(
      <StrictMode>
        <Login />
      </StrictMode>,
    );
    return;
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } },
  });

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// A boot failure would otherwise leave #root empty (no token, so no app) — paint
// a minimal fallback with the error and a button to retry the whole load.
function renderBootError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  createRoot(document.getElementById("root")!).render(
    <div className="mx-auto mt-[15vh] max-w-lg px-6 text-sm">
      <p className="mb-2 font-semibold">Couldn’t reach the r3 daemon.</p>
      <p className="mb-4 break-words font-mono text-xs text-neutral-500">{message}</p>
      <button
        type="button"
        onClick={() => location.reload()}
        className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        Retry
      </button>
    </div>,
  );
}

void main();
