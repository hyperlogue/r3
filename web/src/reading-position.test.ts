import { expect, test } from "bun:test";
import { ReadingPositions, readingKey } from "./reading-position.ts";

test("reading metadata is bounded, version/view scoped, and removed on deletion", () => {
  let stored: string | null = null;
  const storage = () => ({
    getItem: () => stored,
    setItem: (_: string, value: string) => {
      stored = value;
    },
  });
  const positions = new ReadingPositions(storage);
  for (let version = 1; version <= 130; version++)
    positions.set(readingKey("artifact_example", version, "index.md", "rendered"), {
      x: 0,
      y: version,
    });
  const source = readingKey("artifact_example", 130, "index.md", "source");
  positions.set(source, { x: 0, y: 500 });
  positions.set(readingKey("artifact_other", 1, "index.html", "rendered:#"), { x: 0, y: 900 });
  positions.flush();
  const restored = new ReadingPositions(storage);
  expect(restored.get(readingKey("artifact_example", 1, "index.md", "rendered"))).toBeUndefined();
  expect(restored.get(readingKey("artifact_example", 130, "index.md", "rendered"))?.y).toBe(130);
  expect(restored.get(source)?.y).toBe(500);
  expect(JSON.parse(stored!).length).toBe(128);
  restored.forget("artifact_example");
  expect(JSON.parse(stored!).length).toBe(1);
  expect(new ReadingPositions(storage).get(source)).toBeUndefined();
});

test("scroll metadata rejects invalid coordinates and discards extra publisher fields", () => {
  let stored = JSON.stringify([["invalid", { x: 0, y: -1 }]]);
  const positions = new ReadingPositions(() => ({
    getItem: () => stored,
    setItem: (_, value) => {
      stored = value;
    },
  }));
  expect(positions.get("invalid")).toBeUndefined();
  positions.set("invalid", { x: 0, y: Number.POSITIVE_INFINITY });
  expect(positions.get("invalid")).toBeUndefined();
  const supplied = { x: 10, y: 20, publisherData: "not reading metadata" };
  positions.set("valid", supplied);
  supplied.y = 900;
  positions.flush();
  expect(JSON.parse(stored)).toEqual([["valid", { x: 10, y: 20 }]]);
});
