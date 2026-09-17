import { describe, expect, test } from "bun:test";
import type { PublicationFile } from "../shared/artifacts.ts";
import { validatePublication } from "./publication.ts";

const member = (path: string, source = "", mediaType = "text/plain"): PublicationFile => ({
  path,
  mediaType,
  base64: Buffer.from(source).toString("base64"),
});
const publication = (content: unknown) => ({
  actor: { role: "human", sessionId: null },
  expectedSeq: 0,
  publicationKey: "first-publication",
  content,
});

describe("complete publication validation", () => {
  test("files remains a directory without an entrypoint even when an index exists", () => {
    const validated = validatePublication(
      publication({ kind: "files", files: [member("index.md")] }),
    );
    expect(validated.entrypoint).toBeNull();
    expect(validated.files[0].bytes.byteLength).toBe(0);
    expect(() => validatePublication(publication({ kind: "files", files: [] }))).toThrow(
      "at least one",
    );
    expect(() =>
      validatePublication(
        publication({ kind: "files", entrypoint: "index.md", files: [member("index.md")] }),
      ),
    ).toThrow("no entrypoint");
  });

  test("HTML requires a unique root index without an entrypoint override", () => {
    const one = publication({ kind: "html", files: [member("index.md")] });
    expect(validatePublication(one).entrypoint).toBe("index.md");
    const two = {
      kind: "html",
      files: [member("index.md"), member("index.html", "<p>hello</p>", "text/html")],
    };
    for (const entrypoint of [undefined, "index.html", "index.md"])
      expect(() => validatePublication(publication({ ...two, entrypoint }))).toThrow("exactly one");
    expect(() =>
      validatePublication(publication({ kind: "html", files: [member("nested/index.md")] })),
    ).toThrow("root index");
    for (const entrypoint of ["index.html", "index.md"])
      expect(() =>
        validatePublication(publication({ ...(one.content as object), entrypoint })),
      ).toThrow("selected automatically");
  });

  test("file order and metadata key order do not change a publication's identity", () => {
    const first = member("guide.md", "# Guide");
    const second = member("assets/data.json", "{}");
    const a = validatePublication({
      ...publication({ kind: "files", files: [first, second] }),
      provenance: { a: 1, b: { c: 2, d: 3 } },
    });
    const b = validatePublication({
      ...publication({ kind: "files", files: [second, first] }),
      provenance: { b: { d: 3, c: 2 }, a: 1 },
    });
    expect(a.contentHash).toBe(b.contentHash);
    expect(JSON.stringify(a.provenance)).toBe(JSON.stringify(b.provenance));
    const changed = validatePublication(
      publication({ kind: "files", files: [first, member("assets/data.json", "[]")] }),
    );
    expect(changed.contentHash).not.toBe(a.contentHash);
  });

  test("unsafe paths, aliases, duplicate members and file-directory collisions are rejected", () => {
    for (const path of [
      "/absolute",
      "../escape",
      "a/../b",
      "a//b",
      "a/./b",
      "a\\b",
      "a\0b",
      "C:/file",
    ]) {
      expect(() =>
        validatePublication(publication({ kind: "files", files: [member(path)] })),
      ).toThrow();
    }
    for (const files of [
      [member("a"), member("a")],
      [member("a/b"), member("a")],
    ]) {
      expect(() => validatePublication(publication({ kind: "files", files }))).toThrow();
    }
    expect(
      validatePublication(publication({ kind: "files", files: [member("space and ünicode.md")] }))
        .files[0].path,
    ).toBe("space and ünicode.md");
  });

  test("truncated or permissively decodable base64 and header injection are rejected", () => {
    for (const base64 of ["aGVsbG8", "aGVsbG8=\n", "!!!", "Zh=="]) {
      expect(() =>
        validatePublication(publication({ kind: "files", files: [{ ...member("data"), base64 }] })),
      ).toThrow("base64");
    }
    expect(() =>
      validatePublication(
        publication({
          kind: "files",
          files: [member("data", "", "text/plain\r\nX-Test: injected")],
        }),
      ),
    ).toThrow("media type");
    expect(() =>
      validatePublication(publication({ kind: "html", files: [member("index.html")] })),
    ).toThrow("text/html");
  });

  test("normal writes never invent missing attribution, sequence, or retry identity", () => {
    const body = publication({ kind: "files", files: [member("a")] });
    for (const override of [
      { actor: undefined },
      { actor: { role: "human" } },
      { actor: { role: "agent", sessionId: null } },
      { expectedSeq: undefined },
      { expectedSeq: -1 },
      { publicationKey: "" },
      { provenance: null },
      { provenance: [] },
    ])
      expect(() => validatePublication({ ...body, ...override })).toThrow();
  });

  test("deep or cyclic metadata fails validation without exhausting the call stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.child = cyclic;
    let deep: unknown = {};
    for (let i = 0; i < 66; i++) deep = { child: deep };
    for (const provenance of [cyclic, deep]) {
      expect(() =>
        validatePublication({
          ...publication({ kind: "files", files: [member("a")] }),
          provenance,
        }),
      ).toThrow("nested too deeply");
    }
  });

  test("a sparse diff stays an independent patch payload", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -40,1 +70,1 @@\n-old\n+new\n";
    const validated = validatePublication(publication({ kind: "diff", patch }));
    expect(validated.patch).toBe(patch);
    expect(validated.files).toEqual([]);
    expect(validated.entrypoint).toBeNull();
    expect(() => validatePublication(publication({ kind: "diff", patch: "not a patch" }))).toThrow(
      "unified diff",
    );
  });
});
