import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.ts";
import { Button, TrashIcon, useCopyFlash } from "../ui.tsx";

// Manage login tokens from the browser (the settings popup) instead of dropping to
// `r3 auth …`. A token minted here is shown ONCE in a reveal box (it's hashed at
// rest); the list shows the live ones with a revoke button. These tokens gate the
// web UI only when r3 is exposed beyond loopback — you can create one here ahead of
// exposing it.
export function TokenManager() {
  const qc = useQueryClient();
  const { data: tokens } = useQuery({ queryKey: ["auth-tokens"], queryFn: () => api.authTokens() });
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, flash } = useCopyFlash();

  const refresh = () => qc.invalidateQueries({ queryKey: ["auth-tokens"] });

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.createAuthToken({ label: label.trim() || null });
      setRevealed(res.token);
      setLabel("");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api.revokeAuthToken(id);
    refresh();
  }

  // After creating: show the one-time token with a copy button; nothing else until
  // dismissed (there's no getting it back).
  if (revealed) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800/60 dark:bg-amber-950/40">
        <p className="mb-1.5 text-[0.625rem] font-medium text-amber-800 dark:text-amber-300">
          Copy it now — it won’t be shown again.
        </p>
        <div className="mb-2 break-all rounded bg-white px-2 py-1.5 font-mono text-[0.7rem] text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
          {revealed}
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="default"
            onClick={() => navigator.clipboard?.writeText(revealed).then(flash)}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" onClick={() => setRevealed(null)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.625rem] leading-relaxed text-neutral-400">
        Tokens to open r3 when it's exposed beyond loopback (e.g. tailscale serve). Loopback needs
        none.
      </p>

      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (e.g. laptop)"
        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-primary-400 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <Button variant="primary" onClick={create} disabled={busy} className="justify-center">
        {busy ? "Creating…" : "Create login token"}
      </Button>

      {tokens && tokens.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-1">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-1.5 rounded border border-neutral-200 px-1.5 py-1 text-xs dark:border-neutral-800"
            >
              <span className="min-w-0 flex-1 truncate">
                {t.label ?? <span className="text-neutral-400">(no label)</span>}
              </span>
              <button
                type="button"
                title="Revoke"
                onClick={() => revoke(t.id)}
                className="shrink-0 cursor-pointer text-neutral-400 hover:text-danger-600"
              >
                <TrashIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
