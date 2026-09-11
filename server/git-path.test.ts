import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "./git.ts";
import { decodeGitPath, gitHeaderPaths } from "./git-path.ts";
import { validateStoredPatch } from "./patch-content.ts";

describe("git path headers", () => {
  test("separates unquoted names from file-header tab delimiters", () => {
    const patch =
      "diff --git a/new file.txt b/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new file.txt\t\n@@ -0,0 +1 @@\n+new\n";
    expect(validateStoredPatch(patch)[0].path).toBe("new file.txt");
    expect(gitHeaderPaths("diff --git a/has b/name b/has b/name")).toEqual([
      "has b/name",
      "has b/name",
    ]);
  });
  test("decodes quoted UTF-8 octal paths in binary and renamed files", () => {
    const encoded = '"a/caf\\303\\251.bin"';
    expect(decodeGitPath(encoded)).toBe("a/café.bin");
    const binary = `diff --git ${encoded} "b/caf\\303\\251.bin"\nGIT binary patch\nliteral 0\nHcmV?d00001\n`;
    expect(validateStoredPatch(binary)[0]).toMatchObject({ path: "café.bin", binary: true });
    const rename = `diff --git ${encoded} "b/new\\303\\251.bin"\nsimilarity index 100%\nrename from "caf\\303\\251.bin"\nrename to "new\\303\\251.bin"\n`;
    expect(parseUnifiedDiff(rename)[0]).toMatchObject({
      oldPath: "café.bin",
      newPath: "newé.bin",
      status: "renamed",
    });
  });
  test("decoded control and traversal names remain invalid publication paths", () => {
    for (const name of ["bad\\tname", "../outside"]) {
      expect(() =>
        validateStoredPatch(`diff --git "a/${name}" "b/${name}"\nnew file mode 100644\n`),
      ).toThrow("canonical relative paths");
    }
  });
});
