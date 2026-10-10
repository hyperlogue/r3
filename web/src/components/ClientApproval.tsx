import { useState } from "react";
import { api } from "../api.ts";

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
  const button =
    "cursor-pointer rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-neutral-700";
  return (
    <main className="mx-auto mt-[12vh] max-w-lg px-6 text-neutral-900 dark:text-neutral-100">
      <a href="/" className="text-sm text-neutral-500">
        r3
      </a>
      <h1 className="mt-6 mb-3 text-2xl font-semibold">Connect your CLI</h1>
      {result ? (
        <p role="status">{result}</p>
      ) : (
        <>
          <p className="mb-6 text-sm text-neutral-500">
            Approve only a login you started. This client will have access to every artifact and
            threads conversation on this server.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void review();
            }}
          >
            <label htmlFor="approval-code" className="mb-2 block text-sm">
              Code shown in your terminal
            </label>
            <input
              id="approval-code"
              value={code}
              disabled={busy || !!request}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mb-4 block w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono tracking-wider dark:border-neutral-700"
            />
            {!request && (
              <button className={button} disabled={busy || !code.trim()} type="submit">
                Review request
              </button>
            )}
          </form>
          {request && (
            <div className="mt-3 border-y border-neutral-300 py-5 dark:border-neutral-700">
              <p className="mb-2 font-medium">{request.label ?? "r3 CLI"}</p>
              {request.requestIp && (
                <p className="mb-4 text-sm text-neutral-500">Requested from {request.requestIp}</p>
              )}
              <p className="mb-5 text-sm">
                Confirm that the code above matches your terminal. You can revoke this access from
                r3.
              </p>
              <div className="flex gap-3">
                <button
                  className={`${button} bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900`}
                  disabled={busy}
                  onClick={() => void decide(true)}
                  type="button"
                >
                  Approve CLI access
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void decide(false)}
                  type="button"
                >
                  Decline
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </>
      )}
    </main>
  );
}
