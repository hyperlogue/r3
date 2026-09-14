import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ArtifactFeedback } from "../../shared/artifacts.ts";

// Browser receipts record successful pings, never agent acknowledgment. Persist
// hashes only; without Web Crypto, exact inputs remain in memory for this visit.
const storageKey = "r3-feedback-notifications";
type Attempt = { order: number; hashes: string[] };
type Receipt = { issued: number; delivered: Attempt | null };
type Receipts = Record<string, Receipt>;
const isHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
function parse(raw: string | null): Receipts {
  try {
    const value = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => {
        const record = entry as Receipt | null;
        return (
          record &&
          Number.isFinite(record.issued) &&
          (record.delivered === null ||
            (Number.isFinite(record.delivered?.order) &&
              Array.isArray(record.delivered?.hashes) &&
              record.delivered.hashes.every((hash) => typeof hash === "string" && isHash(hash))))
        );
      }),
    ) as Receipts;
  } catch {
    return {};
  }
}
function read(): Receipts {
  try {
    return parse(localStorage.getItem(storageKey));
  } catch {
    return {};
  }
}
function merge(left: Receipts, right: Receipts): Receipts {
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].slice(-100).map((id) => {
      const a = left[id],
        b = right[id];
      const delivered =
        !a?.delivered || (b?.delivered && b.delivered.order > a.delivered.order)
          ? (b?.delivered ?? null)
          : a.delivered;
      return [id, { issued: Math.max(a?.issued ?? 0, b?.issued ?? 0), delivered }];
    }),
  );
}
let receipts = read();
const listeners = new Set<() => void>();
const get = () => receipts;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function update(next: Receipts) {
  receipts = next;
  for (const listener of listeners) listener();
}
window.addEventListener("storage", (event) => {
  if (event.key === storageKey)
    update(event.newValue === null ? {} : merge(receipts, parse(event.newValue)));
});
function save(next: Receipts) {
  update(next);
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(receipts).map(([id, receipt]) => [
            id,
            {
              issued: receipt.issued,
              delivered: receipt.delivered?.hashes.every(isHash) ? receipt.delivered : null,
            },
          ]),
        ),
      ),
    );
  } catch {
    /* Successful delivery remains recorded in memory if storage is full. */
  }
}
function begin(artifactId: string, hashes: string[]): Attempt {
  const latest = merge(receipts, read());
  const current = latest[artifactId] ?? { issued: 0, delivered: null };
  const order = Math.max(Date.now(), current.issued + 1);
  save({ ...latest, [artifactId]: { ...current, issued: order } });
  return { order, hashes };
}
function remember(artifactId: string, attempt: Attempt) {
  // Only the latest successful request's snapshot counts. Older completions must
  // not overwrite it, and historical text/status values must not stay sent forever.
  save(
    merge(merge(receipts, read()), { [artifactId]: { issued: attempt.order, delivered: attempt } }),
  );
}

function pendingInputs(feedback: ArtifactFeedback[]): string[] {
  const inputs: string[] = [];
  for (const note of feedback) {
    if (note.author.role === "human" && note.sentAt === null && note.status === "open")
      inputs.push(JSON.stringify(["note", note.id, note.body, note.updatedAt]));
    if (note.statusUnsent) inputs.push(JSON.stringify(["status", note.id, note.status]));
    for (const reply of note.replies)
      if (reply.author.role === "human" && reply.sentAt === null)
        inputs.push(JSON.stringify(["reply", reply.id, reply.body]));
  }
  return inputs.sort();
}

export function useFeedbackHandoffReceipt(artifactId: string, feedback: ArtifactFeedback[]) {
  const source = useMemo(() => JSON.stringify(pendingInputs(feedback)), [feedback]);
  const [snapshot, setSnapshot] = useState<{ source: string; hashes: string[] } | null>(null);
  const saved = useSyncExternalStore(subscribe, get)[artifactId]?.delivered?.hashes ?? [];
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      (JSON.parse(source) as string[]).map(async (input) => {
        try {
          const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
          return Array.from(new Uint8Array(bytes), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        } catch {
          return `input:${input}`;
        }
      }),
    ).then((hashes) => {
      if (!cancelled) setSnapshot({ source, hashes });
    });
    return () => {
      cancelled = true;
    };
  }, [source]);
  const hashes = snapshot?.source === source ? snapshot.hashes : null;
  return {
    hashes,
    covered: hashes !== null && hashes.length > 0 && hashes.every((hash) => saved.includes(hash)),
    begin: () => hashes && begin(artifactId, hashes),
    remember: (attempt: Attempt) => remember(artifactId, attempt),
  };
}
