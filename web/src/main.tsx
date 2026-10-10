import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactApiError } from "../../shared/artifact-client.ts";
import { App } from "./App.tsx";
import { ApiError, loadBoot } from "./api.ts";
import { takeApplicationBootstrap } from "./application-bootstrap.ts";
import { ApplicationUIProvider } from "./application-ui.tsx";
import { ClientApproval } from "./components/ClientApproval.tsx";
import { Login } from "./components/Login.tsx";
import { readDisplayPreference } from "./display-storage.ts";
import { previewCompatibility } from "./preview-protection.ts";
import { previewSessions } from "./preview-sessions.ts";
import { clampFont } from "./settings.ts";
import "./main.css";

// Restore the saved theme before first paint.
const savedTheme = readDisplayPreference("r3-theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
if (savedTheme === "dark" || (savedTheme == null && prefersDark)) {
  document.documentElement.classList.add("dark");
}
// Clamp/validate here too: the store's clampFont only runs inside get/set, not on
// this raw boot read, so a corrupt or out-of-range stored value would otherwise be
// applied verbatim at first paint. Ignore non-numeric values (leave the CSS default).
const savedFont = Number(readDisplayPreference("r3-font-size"));
if (Number.isFinite(savedFont) && savedFont > 0) {
  document.documentElement.style.setProperty("--r3-font-size", `${clampFont(savedFont)}px`);
}

// Establish auth before rendering. An authenticated shell carries bootstrap and
// its artifact detail; cross-site entry and suspended caches use a fresh read.
async function main() {
  let boot: Awaited<ReturnType<typeof loadBoot>>;
  try {
    boot = await loadBoot(takeApplicationBootstrap());
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
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        // Never retry a 4xx. The server has answered — asking again three more
        // times with backoff can only produce the same answer, and a files review
        // whose branch moved on 404s once per missing file per viewport entry, so
        // the default `retry: 3` multiplied a scroll pass by four. A 5xx or a
        // dropped connection still gets the default three attempts.
        retry: (count, err) =>
          !(
            (err instanceof ApiError || err instanceof ArtifactApiError) &&
            err.status >= 400 &&
            err.status < 500
          ) && count < 3,
      },
    },
  });
  if (boot.artifact) queryClient.setQueryData(["artifact", boot.artifact.id], boot.artifact);
  if (boot.artifact && boot.manifest)
    queryClient.setQueryData(
      ["artifact-files", boot.artifact.id, boot.manifest.versionSeq],
      boot.manifest.files,
    );
  if (
    boot.preview?.applicationOrigin === location.origin &&
    Array.isArray(boot.preview.contexts) &&
    boot.artifact?.kind === "html"
  ) {
    const network = previewCompatibility.accepted() ? "compatible" : "blocked";
    for (const context of boot.preview.contexts) {
      const version = boot.artifact.versions.find((version) => version.seq === context.versionSeq);
      if (
        context.network === network &&
        context.artifactId === boot.artifact.id &&
        version?.kind === "html"
      )
        previewSessions.seed(context, version.entrypoint, boot.preview.retained);
    }
  }

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ApplicationUIProvider>
          {location.pathname === "/authorize" ? <ClientApproval /> : <App />}
        </ApplicationUIProvider>
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
      <p className="mb-2 font-semibold">Couldn’t reach the r3 server.</p>
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

// A restored document must not reuse a pre-logout bootstrap/query snapshot.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
