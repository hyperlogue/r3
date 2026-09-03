import { describe, expect, test } from "bun:test";

// The watch registry is pure in-memory presence — no db.ts, so no R3_DB dance.
import {
  addWatcher,
  dropListener,
  type ListenerTarget,
  listenerFor,
  type Probe,
  removeWatcher,
  watchersOf,
} from "./watchers.ts";

const noop = () => {};
// Each test gets its own review id: the registry is a module-global that lives
// for the whole file, exactly as it does for the daemon's lifetime.
let n = 0;
const review = () => `review_watch_${n++}`;

type Who = { session: string; agentId?: string };

function admit(id: string, info: Who, evict = noop) {
  return addWatcher(id, { ...info, kind: "watch" }, evict);
}

// A `listen` holder: same slot, but reached through an inbox the daemon pushes
// to, so admission may have to probe it.
const target = (socket = "/run/user/0/cc-socks/1.sock"): ListenerTarget => ({
  socket,
  token: "t",
});
const alive: Probe = async () => true;
const dead: Probe = async () => false;

function listen(id: string, info: Who, opts: { probe?: Probe; evict?: () => void } = {}) {
  return addWatcher(id, { ...info, kind: "listen" }, opts.evict ?? noop, {
    target: target(),
    probe: opts.probe,
  });
}

describe("one live watch per review", () => {
  test("admits the first client and names it", async () => {
    const id = review();
    const first = await admit(id, { session: "codex" });
    expect(first.ok).toBe(true);
    expect(watchersOf(id)).toEqual([{ session: "codex", agentId: undefined, kind: "watch" }]);
  });

  test("refuses another session and leaves the holder in place", async () => {
    const id = review();
    await admit(id, { session: "codex" });
    const second = await admit(id, { session: "claude" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder.session).toBe("codex");
    expect(watchersOf(id).map((w) => w.session)).toEqual(["codex"]);
  });

  test("a shared display name with a different agent id is a different client", async () => {
    const id = review();
    await admit(id, { session: "agent", agentId: "pid-1" });
    expect((await admit(id, { session: "agent", agentId: "pid-2" })).ok).toBe(false);
    // ...and so is the same name with no id at all.
    expect((await admit(id, { session: "agent" })).ok).toBe(false);
  });

  test("the same client reconnecting takes its own slot back and evicts the ghost", async () => {
    const id = review();
    let evicted = 0;
    const ghost = await admit(id, { session: "codex", agentId: "a1" }, () => evicted++);
    expect(ghost.ok).toBe(true);
    const again = await admit(id, { session: "codex", agentId: "a1" });
    expect(again.ok).toBe(true);
    expect(evicted).toBe(1);
    expect(watchersOf(id).map((w) => w.session)).toEqual(["codex"]);
  });

  test("the evicted ghost's late cleanup can't free its successor's slot", async () => {
    const id = review();
    const ghost = await admit(id, { session: "codex" });
    const heir = await admit(id, { session: "codex" });
    expect(ghost.ok && heir.ok).toBe(true);
    if (!ghost.ok || !heir.ok) return;
    // The ghost's stream closes after the reconnect already took over.
    expect(removeWatcher(id, ghost.id)).toBe(false);
    expect(watchersOf(id)).toHaveLength(1);
    // The heir still holds it, so a third session is still refused.
    expect((await admit(id, { session: "claude" })).ok).toBe(false);
    expect(removeWatcher(id, heir.id)).toBe(true);
    expect(watchersOf(id)).toEqual([]);
  });

  test("releasing the slot lets the next session in", async () => {
    const id = review();
    const first = await admit(id, { session: "codex" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    removeWatcher(id, first.id);
    expect((await admit(id, { session: "claude" })).ok).toBe(true);
    expect(watchersOf(id).map((w) => w.session)).toEqual(["claude"]);
  });

  test("the slot is per review, not global", async () => {
    const a = review();
    const b = review();
    expect((await admit(a, { session: "codex" })).ok).toBe(true);
    expect((await admit(b, { session: "claude" })).ok).toBe(true);
    expect(watchersOf(a).map((w) => w.session)).toEqual(["codex"]);
    expect(watchersOf(b).map((w) => w.session)).toEqual(["claude"]);
  });
});

describe("watch and listen share the one slot", () => {
  test("a live listener refuses a watch, and says who holds it", async () => {
    const id = review();
    expect((await listen(id, { session: "claude" })).ok).toBe(true);
    const refused = await addWatcher(id, { session: "codex", kind: "watch" }, noop, {
      probe: alive,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.holder).toMatchObject({ session: "claude", kind: "listen" });
  });

  test("a dead listener is evicted at admission so it can't lock the review out", async () => {
    const id = review();
    let evicted = 0;
    expect((await listen(id, { session: "gone" }, { evict: () => evicted++ })).ok).toBe(true);
    // Without probe-at-admission this refusal would stand until someone hit Submit.
    const taken = await addWatcher(id, { session: "codex", kind: "watch" }, noop, { probe: dead });
    expect(taken.ok).toBe(true);
    expect(evicted).toBe(1);
    expect(watchersOf(id)).toEqual([{ session: "codex", agentId: undefined, kind: "watch" }]);
  });

  test("a watch holder is never probed — its connection is the slot", async () => {
    const id = review();
    await admit(id, { session: "codex" });
    let probed = 0;
    const refused = await addWatcher(id, { session: "claude", kind: "watch" }, noop, {
      probe: async () => {
        probed++;
        return false;
      },
    });
    expect(refused.ok).toBe(false);
    expect(probed).toBe(0);
  });

  test("one client may switch watch -> listen and back, reclaiming its own slot", async () => {
    const id = review();
    expect((await admit(id, { session: "claude", agentId: "a1" })).ok).toBe(true);
    // kind is not part of identity, so this is a takeover, not a race.
    expect((await listen(id, { session: "claude", agentId: "a1" })).ok).toBe(true);
    expect(watchersOf(id)).toEqual([{ session: "claude", agentId: "a1", kind: "listen" }]);
    expect(listenerFor(id)?.target).toEqual(target());
    expect((await admit(id, { session: "claude", agentId: "a1" })).ok).toBe(true);
    expect(listenerFor(id)).toBeNull();
  });

  test("listenerFor is null for an empty slot and for a blocked watch", async () => {
    const id = review();
    expect(listenerFor(id)).toBeNull();
    await admit(id, { session: "codex" });
    expect(listenerFor(id)).toBeNull();
  });

  test("dropListener frees a listener, reports it, and ignores a watcher", async () => {
    const id = review();
    await admit(id, { session: "codex" });
    expect(dropListener(id)).toBe(false); // a watch releases with its connection
    expect(watchersOf(id)).toHaveLength(1);

    const other = review();
    await listen(other, { session: "claude" });
    expect(dropListener(other)).toBe(true);
    expect(watchersOf(other)).toEqual([]);
    expect(dropListener(other)).toBe(false); // already gone
  });

  test("a failed push can't drop the registration that replaced it", async () => {
    const id = review();
    expect((await listen(id, { session: "claude", agentId: "a1" })).ok).toBe(true);
    const inFlight = listenerFor(id);
    expect(inFlight).not.toBeNull();
    // The same agent re-registers while a nudge to the old record is still in
    // flight — a push has seconds to run, so this is an ordinary interleaving.
    expect((await listen(id, { session: "claude", agentId: "a1" })).ok).toBe(true);
    // The push then fails and drops what it pushed to; the live record stands.
    expect(dropListener(id, inFlight?.id)).toBe(false);
    expect(watchersOf(id)).toHaveLength(1);
    // Unscoped still drops whoever is listening — what a closed review does.
    expect(dropListener(id)).toBe(true);
    expect(watchersOf(id)).toEqual([]);
  });
});
