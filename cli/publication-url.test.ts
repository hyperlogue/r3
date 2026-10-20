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

test("browser setup failure preserves successful publication and its backend URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-publication-url-"));
  await writeFile(join(root, "note.txt"), "A publication");
  const url = "http://localhost/artifact_fixture";
  let publications = 0;
  const client = new ArtifactClient({
    url: "http://localhost",
    fetch: async (request) => {
      if (request.method === "POST" && request.url.endsWith("/artifacts"))
        return Response.json({ id: "artifact_fixture", kind: "files" });
      if (request.method === "POST" && request.url.endsWith("/versions")) {
        publications++;
        return Response.json({ artifactId: "artifact_fixture", seq: 1, url });
      }
      throw new Error("Unexpected fixture request");
    },
  });
  let output = "";
  const warnings: string[] = [];
  try {
    expect(
      await runArtifactCommand(
        "create",
        ["--kind", "files", "--dir", ".", "--human", "--no-listen", "--json"],
        {
          client,
          browserUrl: async () => {
            expect(publications).toBe(1);
            throw new Error("Private browser setup unavailable");
          },
          cwd: root,
          environment: {},
          stdin: async () => "",
          write: (value) => {
            output += value;
          },
          error: (message) => warnings.push(message),
        },
      ),
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ version: { seq: 1 }, url });
    expect(publications).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Published, but browser sign-in could not be prepared");
    expect(warnings[0]).toContain("r3 open artifact_fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
