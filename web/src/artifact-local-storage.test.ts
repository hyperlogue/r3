import { expect, test } from "bun:test";
import {
  ArtifactLocalStorage,
  mutateStorage,
  type StorageValues,
} from "./artifact-local-storage.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
  } as Storage;
}

test("artifact keys, clear, and reloads cannot read or erase application or sibling state", () => {
  const native = memoryStorage();
  native.setItem("r3-theme", "private");
  const storage = new ArtifactLocalStorage(() => native);
  const first = storage.bind("first", () => {});
  const second = storage.bind("second", () => {});
  first.write({ id: 1, operation: { type: "set", key: "r3-theme", value: "light" } });
  first.write({ id: 2, operation: { type: "set", key: "__proto__", value: "ordinary key" } });
  second.write({ id: 1, operation: { type: "set", key: "r3-theme", value: "dark" } });
  expect(first.snapshot()).toEqual([
    ["r3-theme", "light"],
    ["__proto__", "ordinary key"],
  ]);
  expect(second.snapshot()).toEqual([["r3-theme", "dark"]]);
  const reloaded = new ArtifactLocalStorage(() => native);
  expect(reloaded.snapshot("first")).toEqual(first.snapshot());
  first.write({ id: 3, operation: { type: "clear" } });
  expect(first.snapshot()).toEqual([]);
  expect(native.getItem("r3-theme")).toBe("private");
  expect(second.snapshot()).toEqual([["r3-theme", "dark"]]);
});

test("independent tab writes retain other keys and are observable by connected previews", () => {
  const native = memoryStorage();
  const one = new ArtifactLocalStorage(() => native);
  const two = new ArtifactLocalStorage(() => native);
  const received: StorageValues[] = [];
  const first = one.bind("same", (values) => received.push(values));
  const second = two.bind("same", () => {});
  first.write({ id: 1, operation: { type: "set", key: "one", value: "1" } });
  second.write({ id: 1, operation: { type: "set", key: "two", value: "2" } });
  one.changed("r3-artifact-storage:same:two");
  expect(received.at(-1)).toEqual([
    ["one", "1"],
    ["two", "2"],
  ]);
});

test("logout rejects stale writers across tabs before storage events and stale bootstrap resumes", () => {
  const native = memoryStorage();
  const one = new ArtifactLocalStorage(() => native);
  const two = new ArtifactLocalStorage(() => native);
  const first = one.bind("same", () => {});
  const second = two.bind("same", () => {});
  first.write({ id: 1, operation: { type: "set", key: "secret", value: "saved" } });
  const oldBoot = one.authenticationEpoch();
  one.suspend();
  first.write({ id: 2, operation: { type: "set", key: "secret", value: "late" } });
  second.write({ id: 1, operation: { type: "set", key: "secret", value: "late tab" } });
  one.resume(oldBoot);
  expect(one.authenticationSuspended()).toBe(true);
  one.resume(one.authenticationEpoch());
  expect(one.authenticationSuspended()).toBe(false);
  expect(one.snapshot("same")).toEqual([]);
  expect(two.snapshot("same")).toEqual([]);
});

test("deletion rejects stale writers in other tabs without clearing another artifact", () => {
  const native = memoryStorage();
  const one = new ArtifactLocalStorage(() => native);
  const two = new ArtifactLocalStorage(() => native);
  const stale = two.bind("deleted", () => {});
  const kept = one.bind("kept", () => {});
  kept.write({ id: 1, operation: { type: "set", key: "value", value: "keep" } });
  one.forget("deleted");
  stale.write({ id: 1, operation: { type: "set", key: "value", value: "late" } });
  expect(one.snapshot("deleted")).toEqual([]);
  expect(kept.snapshot()).toEqual([["value", "keep"]]);
});

test("storage failure retains usable in-memory state and bounded writes", () => {
  const storage = new ArtifactLocalStorage(() => {
    throw new Error("Unavailable");
  });
  const first = storage.bind("same", () => {});
  first.write({ id: 1, operation: { type: "set", key: "theme", value: "light" } });
  expect(storage.snapshot("same")).toEqual([["theme", "light"]]);
  expect(() =>
    mutateStorage([], { type: "set", key: "large", value: "x".repeat(256 * 1024) }),
  ).toThrow("quota");
  first.write({ id: 2, operation: { type: "set", key: "large", value: "x".repeat(256 * 1024) } });
  expect(storage.snapshot("same")).toEqual([["theme", "light"]]);
});

test("legacy showcase preferences migrate once and clear stays cleared", () => {
  const native = memoryStorage();
  native.setItem("r3-artifact-theme:legacy", "dark");
  const storage = new ArtifactLocalStorage(() => native);
  const area = storage.bind("legacy", () => {});
  expect(area.snapshot()).toEqual([["r3-showcase-theme", "dark"]]);
  area.write({ id: 1, operation: { type: "clear" } });
  expect(area.snapshot()).toEqual([]);
  expect(native.getItem("r3-artifact-theme:legacy")).toBe("dark");
});

test("readable storage restores values when the browser refuses writes", () => {
  const native = memoryStorage();
  native.setItem("r3-artifact-storage:same:theme", "dark");
  native.setItem = () => {
    throw new DOMException("Full", "QuotaExceededError");
  };
  const storage = new ArtifactLocalStorage(() => native);
  const area = storage.bind("same", () => {});
  expect(area.snapshot()).toEqual([["theme", "dark"]]);
  area.write({ id: 1, operation: { type: "set", key: "theme", value: "light" } });
  expect(area.snapshot()).toEqual([["theme", "light"]]);
});

test("keys preserve arbitrary UTF-16 strings without escaping into another namespace", () => {
  const native = memoryStorage();
  const storage = new ArtifactLocalStorage(() => native);
  const area = storage.bind("same", () => {});
  const key = "\ud800:%r3-artifact-storage:other:secret";
  area.write({ id: 1, operation: { type: "set", key, value: "saved" } });
  expect(new ArtifactLocalStorage(() => native).snapshot("same")).toEqual([[key, "saved"]]);
  expect(storage.snapshot("other")).toEqual([]);
});
