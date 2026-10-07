import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactSource, artifactSourceResponse } from "./artifact-source.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
let id: string;
const actor = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-artifact-source-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    render: async () => ({ html: "<h1>Rendered heading</h1>", revision: "source-test" }),
  });
  id = storage.artifacts.create({ kind: "files", actor }).id;
  await storage.artifacts.publish(id, {
    actor,
    expectedSeq: 0,
    publicationKey: "source",
    content: {
      kind: "files",
      files: [
        {
          path: "page.html",
          mediaType: "text/html",
          base64: Buffer.from(
            '<script>console.log("page")</script>\r\n<p>Second line</p>\r\n',
          ).toString("base64"),
        },
        {
          path: "notes.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Source heading\n").toString("base64"),
        },
        {
          path: "bytes.bin",
          mediaType: "application/octet-stream",
          base64: Buffer.from([0, 255, 42]).toString("base64"),
        },
        { path: "empty.txt", mediaType: "text/plain", base64: "" },
      ],
    },
  });
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});

describe("published source rendering", () => {
  test("additional grammars highlight published bytes without changing source coordinates", async () => {
    const samples = [
      ["main.dart", "dart", 'void main() { print("<script>"); }'],
      ["Main.hs", "haskell", 'main = putStrLn "<script>"'],
      ["core.clj", "clojure", '(defn main [] (println "<script>"))'],
      ["main.zig", "zig", 'const message = "<script>";'],
      ["Makefile", "make", "all:\n\techo '<script>'"],
      [".bashrc", "shellscript", 'export MESSAGE="<script>"'],
      ["page.blade.php", "blade", "@if ($ready)\n<p>{{ $message }}</p>\n@endif"],
    ];
    await storage.artifacts.publish(id, {
      actor,
      expectedSeq: 1,
      publicationKey: "languages",
      content: {
        kind: "files",
        files: samples.map(([path, , code]) => ({
          path,
          mediaType: "text/plain",
          base64: Buffer.from(`${code}\n`).toString("base64"),
        })),
      },
    });
    for (const [path, language, code] of samples) {
      const result = await artifactSource(storage.artifacts, id, 2, path);
      expect(result.language).toBe(language);
      expect(result.lines.map((line) => line.text)).toEqual(code.split("\n"));
      expect(result.lines.map((line) => line.lineNo)).toEqual(
        code.split("\n").map((_, index) => index + 1),
      );
      expect(result.lines.map((line) => line.html).join("\n")).toContain('<span class="');
      expect(result.lines.map((line) => line.html).join("\n")).not.toContain("<script>");
    }
  });

  test("conditional source reads skip blob access while checking membership and theme", async () => {
    const request = new Request("https://app.example/source");
    const first = await artifactSourceResponse(
      storage.artifacts,
      request,
      id,
      1,
      "notes.md",
      "github-light",
    );
    const conditional = new Request(request, {
      headers: { "if-none-match": first.headers.get("etag")! },
    });
    const original = storage.artifacts.readFile.bind(storage.artifacts);
    let reads = 0;
    storage.artifacts.readFile = (...args) => {
      reads++;
      return original(...args);
    };
    const reused = await artifactSourceResponse(
      storage.artifacts,
      conditional,
      id,
      1,
      "notes.md",
      "github-light",
    );
    expect(reused.status).toBe(304);
    expect(reads).toBe(0);
    expect(
      (
        await artifactSourceResponse(
          storage.artifacts,
          conditional,
          id,
          1,
          "notes.md",
          "github-dark",
        )
      ).status,
    ).toBe(200);
    expect(reads).toBe(1);
    storage.artifacts.delete(id);
    expect(() =>
      artifactSourceResponse(storage.artifacts, conditional, id, 1, "notes.md", "github-light"),
    ).toThrow();
  });
  test("HTML is escaped source with original native line coordinates", async () => {
    const source = await artifactSource(storage.artifacts, id, 1, "page.html");
    expect(source.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect(source.lines[0].text).toStartWith("<script>");
    expect(source.lines.map((line) => line.html).join("")).not.toContain("<script>");
    expect(source.hash).toBe(storage.artifacts.file(id, 1, "page.html").hash);
    expect(source.kind).toBe("text");
    await expect(artifactSource(storage.artifacts, id, 2, "page.html")).rejects.toMatchObject({
      status: 404,
    });
  });
  test("Markdown source remains separate from retained rendering and binary files have no invented lines", async () => {
    const markdown = await artifactSource(storage.artifacts, id, 1, "notes.md");
    expect(markdown.lines[0].text).toBe("# Source heading");
    expect(markdown.lines[0].html).not.toContain("Rendered heading");
    const binary = await artifactSource(storage.artifacts, id, 1, "bytes.bin");
    expect(binary).toMatchObject({ kind: "binary", lines: [], byteLength: 3 });
    const empty = await artifactSource(storage.artifacts, id, 1, "empty.txt");
    expect(empty).toMatchObject({ kind: "text", byteLength: 0, lines: [{ lineNo: 1, text: "" }] });
  });
});
