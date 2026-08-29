import { describe, expect, test } from "bun:test";

// Pure compression helper — no db.ts, so no R3_DB dance (like watchers.test.ts).
import { GZIP_OFF_THREAD_MIN, gzipBody } from "./compress.ts";

// Compressible the way a JSON response is: repeated keys, varying values.
function body(bytes: number): Uint8Array<ArrayBuffer> {
  const parts: string[] = [];
  let total = 0;
  let i = 0;
  while (total < bytes) {
    const s = `{"id":"feedback_${i.toString(36)}","body":"a reviewer note, number ${i}"},`;
    parts.push(s);
    total += s.length;
    i++;
  }
  return Buffer.from(`[${parts.join("")}]`);
}

// Counts event-loop turns: a timer can only fire between tasks, so the count is
// zero for as long as one synchronous call holds the thread.
async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  let ticks = 0;
  const t = setInterval(() => {
    ticks++;
  }, 5);
  await new Promise((r) => setTimeout(r, 20)); // let the timer settle first
  ticks = 0;
  await work();
  clearInterval(t);
  return ticks;
}

describe("gzipBody", () => {
  test("round-trips a small body (the synchronous path)", async () => {
    const small = body(4 * 1024);
    expect(small.byteLength).toBeLessThan(GZIP_OFF_THREAD_MIN);
    const gz = await gzipBody(small);
    expect(gz.byteLength).toBeLessThan(small.byteLength);
    expect(Bun.gunzipSync(gz)).toEqual(small);
  });

  test("round-trips a big body (the off-thread path)", async () => {
    const big = body(GZIP_OFF_THREAD_MIN * 4);
    expect(big.byteLength).toBeGreaterThan(GZIP_OFF_THREAD_MIN);
    const gz = await gzipBody(big);
    expect(Bun.gunzipSync(gz)).toEqual(big);
  });

  // The reason this module exists: the daemon serves SSE and holds `r3 watch`
  // open on the same thread, so a multi-MB response must not stop the clock
  // while it compresses. Sync gzip is the control — it provably admits nothing.
  test("a timer keeps firing while a multi-MB body compresses", async () => {
    const huge = body(16 * 1024 * 1024);

    const blocked = await ticksDuring(async () => {
      Bun.gzipSync(huge);
    });
    expect(blocked).toBe(0);

    const offThread = await ticksDuring(() => gzipBody(huge));
    expect(offThread).toBeGreaterThan(2);
  });
});
