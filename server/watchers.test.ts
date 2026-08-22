import { describe, expect, test } from "bun:test";

// The watch registry is pure in-memory presence — no db.ts, so no R3_DB dance.
import { addWatcher, removeWatcher, watchersOf } from "./watchers.ts";

const noop = () => {};
// Each test gets its own review id: the registry is a module-global that lives
// for the whole file, exactly as it does for the daemon's lifetime.
let n = 0;
const review = () => `review_watch_${n++}`;

function admit(id: string, info: { session: string; agentId?: string }, evict = noop) {
  return addWatcher(id, info, evict);
}

describe("one live watch per review", () => {
  test("admits the first client and names it", () => {
    const id = review();
    const first = admit(id, { session: "codex" });
    expect(first.ok).toBe(true);
    expect(watchersOf(id)).toEqual([{ session: "codex", agentId: undefined }]);
  });

  test("refuses another session and leaves the holder in place", () => {
    const id = review();
    admit(id, { session: "codex" });
    const second = admit(id, { session: "claude" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder.session).toBe("codex");
    expect(watchersOf(id).map((w) => w.session)).toEqual(["codex"]);
  });

  test("a shared display name with a different agent id is a different client", () => {
    const id = review();
    admit(id, { session: "agent", agentId: "pid-1" });
    expect(admit(id, { session: "agent", agentId: "pid-2" }).ok).toBe(false);
    // ...and so is the same name with no id at all.
    expect(admit(id, { session: "agent" }).ok).toBe(false);
  });

  test("the same client reconnecting takes its own slot back and evicts the ghost", () => {
    const id = review();
    let evicted = 0;
    const ghost = admit(id, { session: "codex", agentId: "a1" }, () => evicted++);
    expect(ghost.ok).toBe(true);
    const again = admit(id, { session: "codex", agentId: "a1" });
    expect(again.ok).toBe(true);
    expect(evicted).toBe(1);
    expect(watchersOf(id).map((w) => w.session)).toEqual(["codex"]);
  });

  test("the evicted ghost's late cleanup can't free its successor's slot", () => {
    const id = review();
    const ghost = admit(id, { session: "codex" });
    const heir = admit(id, { session: "codex" });
    expect(ghost.ok && heir.ok).toBe(true);
    if (!ghost.ok || !heir.ok) return;
    // The ghost's stream closes after the reconnect already took over.
    expect(removeWatcher(id, ghost.id)).toBe(false);
    expect(watchersOf(id)).toHaveLength(1);
    // The heir still holds it, so a third session is still refused.
    expect(admit(id, { session: "claude" }).ok).toBe(false);
    expect(removeWatcher(id, heir.id)).toBe(true);
    expect(watchersOf(id)).toEqual([]);
  });

  test("releasing the slot lets the next session in", () => {
    const id = review();
    const first = admit(id, { session: "codex" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    removeWatcher(id, first.id);
    expect(admit(id, { session: "claude" }).ok).toBe(true);
    expect(watchersOf(id).map((w) => w.session)).toEqual(["claude"]);
  });

  test("the slot is per review, not global", () => {
    const a = review();
    const b = review();
    expect(admit(a, { session: "codex" }).ok).toBe(true);
    expect(admit(b, { session: "claude" }).ok).toBe(true);
    expect(watchersOf(a).map((w) => w.session)).toEqual(["codex"]);
    expect(watchersOf(b).map((w) => w.session)).toEqual(["claude"]);
  });
});
