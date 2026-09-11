import { expect, test } from "bun:test";
import { readEventStream } from "./event-stream.ts";

test("authenticated SSE parser handles split UTF-8, CRLF, fields, and multiple frames per chunk", async () => {
  const bytes = new TextEncoder().encode(
    "\uFEFF: heartbeat\r\nevent: changed\r\nid: frame-1\r\ndata: Café\r\ndata: second line\r\n\r\ndata: next\n\nevent: ignored\ndata: incomplete",
  );
  for (const width of [1, 2, 7, bytes.length]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += width)
          controller.enqueue(bytes.slice(offset, offset + width));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of readEventStream(stream)) frames.push(frame);
    expect(frames).toEqual([
      { event: "changed", id: "frame-1", data: "Café\nsecond line" },
      { event: "message", id: "frame-1", data: "next" },
    ]);
  }
});

test("ending SSE consumption cancels the outward connection", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const frame of readEventStream(stream)) {
    expect(frame.data).toBe("ready");
    break;
  }
  expect(cancelled).toBe(true);
});
