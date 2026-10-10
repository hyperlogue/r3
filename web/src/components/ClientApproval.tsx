import { useState } from "react";
import { api } from "../api.ts";
import { Button } from "../ui.tsx";
import { SettingsPopup } from "./SettingsPopup.tsx";
import { WorkspaceHeader } from "./WorkspaceHeader.tsx";

export function ClientApproval() {
  const [code, setCode] = useState(new URLSearchParams(location.search).get("code") ?? "");
  const [request, setRequest] = useState<{ label: string | null; requestIp: string | null } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const review = async () => {
    setBusy(true);
    setError("");
    try {
      setRequest(await api.inspectClientAuthorization(code));
    } catch {
      setError("This code is unavailable or expired. Start r3 login again.");
    } finally {
      setBusy(false);
    }
  };
  const decide = async (approved: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api.decideClientAuthorization(code, approved);
      setResult(
        approved ? "CLI access approved. You can return to your terminal." : "Access declined.",
      );
    } catch {
      setError("The request could not be completed. Check the code and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <WorkspaceHeader homeHref="/" tools={<SettingsPopup />}>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
          CLI access
        </span>
      </WorkspaceHeader>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-12 max-md:py-6">
        <section
          aria-labelledby="approval-title"
          className="mx-auto w-full max-w-md border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950"
        >
          <div className="border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
            <h1 id="approval-title" className="text-sm font-semibold">
              Connect your CLI
            </h1>
          </div>
          <div className="p-5">
            {result ? (
              <>
                <p role="status" className="text-sm leading-relaxed">
                  {result}
                </p>
                <a
                  href="/"
                  className="mt-4 inline-block text-xs font-medium text-primary-600 hover:underline max-md:py-2 dark:text-primary-400"
                >
                  Return to artifacts
                </a>
              </>
            ) : (
              <>
                <p className="mb-4 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  Approve only a login you started. This client will have access to every artifact
                  and conversation on this server.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void review();
                  }}
                >
                  <label htmlFor="approval-code" className="mb-1.5 block text-xs font-medium">
                    Code shown in your terminal
                  </label>
                  <input
                    id="approval-code"
                    value={code}
                    disabled={busy || !!request}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-2 font-mono text-sm tracking-wider outline-none focus:border-primary-400 disabled:bg-neutral-50 disabled:text-neutral-500 max-md:text-base dark:border-neutral-700 dark:bg-neutral-900 dark:disabled:bg-neutral-900 dark:disabled:text-neutral-400"
                  />
                  {!request && (
                    <Button
                      variant="primary"
                      className="mt-4 w-full justify-center py-1.5"
                      disabled={busy || !code.trim()}
                      type="submit"
                    >
                      {busy ? "Reviewing…" : "Review request"}
                    </Button>
                  )}
                </form>
                {request && (
                  <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
                    <p className="break-words text-sm font-medium">{request.label ?? "r3 CLI"}</p>
                    {request.requestIp && (
                      <p className="mt-1 break-words text-xs text-neutral-500 dark:text-neutral-400">
                        Requested from {request.requestIp}
                      </p>
                    )}
                    <p className="mt-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                      Confirm that the code above matches your terminal. You can revoke this access
                      from r3.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        className="flex-1 justify-center py-1.5"
                        disabled={busy}
                        onClick={() => void decide(true)}
                        type="button"
                      >
                        Approve CLI access
                      </Button>
                      <Button disabled={busy} onClick={() => void decide(false)} type="button">
                        Decline
                      </Button>
                    </div>
                  </div>
                )}
                {error && (
                  <p
                    role="alert"
                    className="mt-4 text-xs leading-relaxed text-danger-600 dark:text-danger-400"
                  >
                    {error}
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
