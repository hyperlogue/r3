import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactClient } from "../shared/artifact-client.ts";
import { ArtifactArgs } from "./artifact-args.ts";
import { publishArtifactCommand } from "./artifact-publish.ts";

test("publication validates capture before create and preserves recovery identity on a lost response", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-publish-command-"));
  const calls: { path: string; body: unknown }[] = [];
  const notices: string[] = [];
  const client = new ArtifactClient({
    url: "http://localhost",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      calls.push({ path, body: await request.json() });
      if (path === "/api/artifacts") return Response.json({ id: "artifact_created", kind: "html" });
      throw new Error("Lost connection after upload");
    },
  });
  const ctx = {
    client,
    actor: { role: "human" as const, sessionId: null },
    cwd: root,
    stdin: async () => "",
    text: async () => undefined,
    error: (message: string) => notices.push(message),
  };
  try {
    const args = new ArtifactArgs(["--kind", "html", "--dir", ".", "--key", "recover-publication"]);
    await expect(publishArtifactCommand("create", args, ctx)).rejects.toThrow();
    expect(calls).toEqual([]);
    await writeFile(join(root, "index.html"), "<h1>Published</h1>");
    await expect(publishArtifactCommand("create", args, ctx)).rejects.toThrow("Lost connection");
    expect(calls[1].body).toMatchObject({
      expectedSeq: 0,
      publicationKey: "recover-publication",
      content: { kind: "html", files: [{ path: "index.html" }] },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      "Artifact: artifact_created; retry key: recover-publication; expected: 0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
