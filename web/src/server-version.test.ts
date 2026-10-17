import { expect, test } from "bun:test";
import { ServerVersionStore } from "./server-version.ts";

test("the first response compares against the loaded bundle, and repeats do not duplicate notices", () => {
  const store = new ServerVersionStore("2.2.0");
  let changes = 0;
  store.subscribe(() => changes++);
  store.beginRequest()("2.3.0");
  expect(store.getSnapshot()).toBe("2.3.0");
  store.beginRequest()("2.3.0");
  expect(changes).toBe(1);
  for (const unknown of [null, "", "test", "2.3", "<script>"]) store.beginRequest()(unknown);
  expect(store.getSnapshot()).toBe("2.3.0");
  expect(changes).toBe(1);
});

test("late responses cannot overwrite a newer observation after reconnect or rollback", () => {
  const store = new ServerVersionStore("2.2.0");
  const old = store.beginRequest();
  const upgraded = store.beginRequest();
  upgraded("2.3.0");
  old("2.2.0");
  expect(store.getSnapshot()).toBe("2.3.0");
  const beforeRollback = store.beginRequest();
  store.beginRequest()("2.2.0+rebuild");
  beforeRollback("2.3.0");
  expect(store.getSnapshot()).toBeNull();
  store.beginRequest()("2.1.0");
  expect(store.getSnapshot()).toBe("2.1.0");
});

test("same release restarts and build metadata do not prompt a refresh", () => {
  const store = new ServerVersionStore("2.2.0");
  store.beginRequest()("2.2.0");
  store.beginRequest()("2.2.0+build.2");
  expect(store.getSnapshot()).toBeNull();
});
