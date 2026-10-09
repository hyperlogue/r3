import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactClient } from "../shared/artifact-client.ts";
import { runArtifactCommand } from "./artifact-commands.ts";

test("publication output preserves an independent backend's display URL in text and JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-publication-url-"));
  await writeFile(join(root, "note.txt"), "A publication");
  const url = "https://display.example/reviews/open?item=opaque";
  // Independent HTTP implementation: no r3 server, database or route builder.
  const client = new ArtifactClient({
    url: "https://api.example/workspace",
    fetch: async (request) => {
      if (request.method === "POST" && request.url.endsWith("/artifacts"))
        return Response.json({ id: "artifact_fixture", kind: "files" });
      if (request.method === "POST" && request.url.endsWith("/versions"))
        return Response.json({ artifactId: "artifact_fixture", seq: 1, url });
      throw new Error("Unexpected fixture request");
    },
  });
  try {
    for (const json of [false, true]) {
      let output = "";
      expect(
        await runArtifactCommand(
          "create",
          ["--kind", "files", "--dir", ".", "--human", "--no-listen", ...(json ? ["--json"] : [])],
          {
            client,
            cwd: root,
            environment: {},
            stdin: async () => "",
            write: (value) => {
              output += typeof value === "string" ? value : new TextDecoder().decode(value);
            },
            error: () => {},
          },
        ),
      ).toBe(0);
      if (json) expect(JSON.parse(output).url).toBe(url);
      else expect(output.split("\n")).toContain(url);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
