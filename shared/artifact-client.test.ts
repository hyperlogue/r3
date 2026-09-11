import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ArtifactClient } from "./artifact-client.ts";

test("artifact clients reject a previous protocol and preserve committed lifecycle errors", async () => {
  const old = new ArtifactClient({
    url: "http://localhost",
    fetch: async () => Response.json({ ok: true, version: "previous" }),
  });
  await expect(old.checkProtocol()).rejects.toThrow("previous review protocol");
  const result = {
    event: { event: "archived", message: "Saved" },
    notification: { state: "failed", error: "Harness unavailable" },
  };
  const client = new ArtifactClient({
    url: "https://app.example",
    fetch: async () => Response.json(result, { status: 502 }),
  });
  await expect(
    client.json("POST", "/api/artifacts/artifact_test/lifecycle", {}),
  ).rejects.toMatchObject({ status: 502, result, message: "Harness unavailable" });
});

test("authenticated requests cannot follow a redirect with credentials or upload bytes", async () => {
  const token = randomBytes(32).toString("base64url");
  const client = new ArtifactClient({
    url: "https://app.example",
    token,
    fetch: async (request) => {
      expect(request.redirect).toBe("error");
      expect(request.headers.get("x-r3-token")).toBe(token);
      expect(await request.json()).toEqual({ content: "published bytes" });
      return Response.json({ ok: true });
    },
  });
  await client.json("POST", "/api/artifacts/artifact_test/versions", {
    content: "published bytes",
  });
  await expect(client.request("GET", "https://untrusted.example/api/artifacts")).rejects.toThrow(
    "Invalid artifact API path",
  );
});
