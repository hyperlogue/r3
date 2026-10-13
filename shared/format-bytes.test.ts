import { expect, test } from "bun:test";
import { formatBytes } from "./format-bytes.ts";

test("bytes are whole numbers and units step at 1000 (decimal)", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(999)).toBe("999 B");
  expect(formatBytes(1000)).toBe("1 KB");
  expect(formatBytes(1500)).toBe("1.5 KB");
  expect(formatBytes(2_500_000)).toBe("2.5 MB");
});

test("a value that would round to 1000 is promoted to the next unit", () => {
  expect(formatBytes(999_949)).toBe("999.9 KB");
  expect(formatBytes(999_950)).toBe("1 MB");
});

test("the largest unit is PB and is never exceeded", () => {
  expect(formatBytes(1e15)).toBe("1 PB");
  expect(formatBytes(1e21)).toBe(`${(1e6).toLocaleString()} PB`);
});
