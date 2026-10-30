import { expect, test } from "bun:test";
import { LocalBrowserAccess } from "./local-access.ts";

test("local sign-in tickets remain valid for five minutes and are single-use", () => {
  let now = 0;
  const access = new LocalBrowserAccess(() => now);
  const afterOneMinute = access.issue();
  const beforeExpiry = access.issue();
  const atExpiry = access.issue();
  now = 60_001;
  expect(access.consume(afterOneMinute)).toBe(true);
  expect(access.consume(afterOneMinute)).toBe(false);
  now = 299_999;
  expect(access.consume(beforeExpiry)).toBe(true);
  now = 300_000;
  expect(access.consume(atExpiry)).toBe(false);
});

test("ticket cleanup and replacing the issuer discard unused links", () => {
  let now = 0;
  const access = new LocalBrowserAccess(() => now);
  const expired = access.issue();
  now = 300_000;
  access.cleanup();
  expect(access.consume(expired)).toBe(false);
  const pending = access.issue();
  expect(new LocalBrowserAccess(() => now).consume(pending)).toBe(false);
  expect(access.consume(pending)).toBe(true);
});
