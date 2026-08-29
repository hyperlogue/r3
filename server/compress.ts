// gzip for JSON responses, kept off the daemon's event loop for big bodies.
//
// The daemon is single-threaded and deflate is CPU-bound, so `Bun.gzipSync` on a
// multi-MB body (a wide diff round, a highlighted blob) blocks the loop for the
// WHOLE compression — SSE frames queue up behind it and a blocked `r3 watch`
// waits, the same stall `highlight-worker.ts` exists to avoid on the tokenizer
// side. `node:zlib`'s callback API runs the deflate on libuv's thread pool, so
// the loop keeps turning while it works.
//
// Measured on Bun 1.3 (a 5ms `setInterval` metering tick lag next to one
// compression of a JSON-shaped body):
//
//   body    Bun.gzipSync (worst tick lag)   node:zlib async   CompressionStream
//   0.4MB              2.2ms                     1.6ms              1.2ms
//   4MB               19.1ms                     1.8ms              6.1ms
//   20MB             101.1ms                     1.1ms             28.0ms
//
// `CompressionStream` was measured too and loses on both axes — it pumps every
// chunk through the main thread (28ms of lag at 20MB) and is ~35% slower in wall
// time — so the plain async call is what we use.
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

const gzipOffThread = promisify(gzipCallback);

// Under this, a synchronous gzip is the cheaper answer: `Bun.gzipSync` blocks
// ~0.9ms at 256KB — inside a single event-loop tick — while the hop to the pool
// costs about as much wall time as it saves (measured 0.89ms sync vs 1.04ms
// async at that size). Past it the block grows ~4ms/MB and the hop is free.
export const GZIP_OFF_THREAD_MIN = 256 * 1024;

/**
 * gzip `data`, off the event loop once it's big enough to be worth the hop.
 * The `Uint8Array<ArrayBuffer>` shape is what `Response`/Hono's `c.body` take;
 * zlib hands back a pooled `Buffer`, never a SharedArrayBuffer view, so the
 * narrowing cast is sound.
 */
export async function gzipBody(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (data.byteLength < GZIP_OFF_THREAD_MIN) return Bun.gzipSync(data);
  return (await gzipOffThread(data)) as Uint8Array<ArrayBuffer>;
}
