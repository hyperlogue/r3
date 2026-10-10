import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRuntime, workerApi } from "./worker-runtime.ts";

test("private worker API rejects missing credentials and every browser Origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-worker-api-"));
  const runtime = new WorkerRuntime(join(root, "worker-state.json"));
  const token = randomBytes(32).toString("hex");
  let stopped = false;
  const app = workerApi(runtime, token, () => {
    stopped = true;
  });
  try {
    expect((await app.request("/api/local/status")).status).toBe(403);
    for (const origin of ["", "null", "http://localhost"]) {
      expect(
        (await app.request("/api/local/status", { headers: { "x-r3-token": token, origin } }))
          .status,
      ).toBe(403);
      expect(
        (
          await app.request("/api/local/stop", {
            method: "POST",
            headers: { "x-r3-token": token, origin },
          })
        ).status,
      ).toBe(403);
    }
    expect((await app.request("/api/local/stop", { method: "POST" })).status).toBe(403);
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    expect(
      (
        await app.request("/api/local/stop", {
          method: "POST",
          headers: { "x-r3-token": token },
        })
      ).status,
    ).toBe(200);
    await Bun.sleep(10);
    expect(stopped).toBe(true);
    expect(
      (await app.request("/api/local/status", { headers: { "x-r3-token": token } })).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/local/intent", {
          method: "POST",
          headers: { "x-r3-token": token, "content-type": "application/json" },
          body: JSON.stringify({ url: "https://backend.example", subscription: {} }),
        })
      ).status,
    ).toBe(404);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
