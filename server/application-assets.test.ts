import { expect, test } from "bun:test";
import { type ApplicationAssets, applicationAssetResponse } from "./application-assets.ts";

test("application bytes have frame protections and only artifact routes get the shell", async () => {
  const assets: ApplicationAssets = {
    index: {
      body: new Blob(["<!doctype html><title>r3</title>"]),
      contentType: "text/html",
      etag: '"shell"',
    },
    files: new Map([
      [
        "/chunk-fixture.js",
        {
          body: new Blob(["const fixture = true;"]),
          contentType: "text/javascript",
          etag: '"script"',
        },
      ],
    ]),
  };
  const read = (path: string, options?: RequestInit) =>
    applicationAssetResponse(assets, new Request(`http://localhost${path}`, options));
  for (const path of ["/", "/artifact_fixture", "/review_imported"]) {
    const response = read(path);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("<title>r3</title>");
  }
  for (const path of [
    "/api/missing",
    "/files/index.html",
    "/chunk-missing.js",
    "/artifact_fixture/anything",
  ])
    expect(read(path).status).toBe(404);
  expect(read("/", { method: "POST" }).status).toBe(405);
  expect(await read("/chunk-fixture.js", { method: "HEAD" }).text()).toBe("");
  expect(read("/chunk-fixture.js", { headers: { "if-none-match": '"script"' } }).status).toBe(304);
});
