import { describe, expect, test } from "bun:test";
import { renderStoredPatch, storedPatchContext, validateStoredPatch } from "./patch-content.ts";

const header = "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n";

describe("stored patch content", () => {
  test("ordinary unified patches retain file boundaries and header-like source lines", () => {
    const patch =
      "--- before.sql\t2026-09-11\n+++ after.sql\t2026-09-11\n@@ -1 +1 @@\n--- removed comment\n+++ added expression\n--- removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n\\ No newline at end of file\n";
    const files = validateStoredPatch(patch);
    expect(files.map((file) => file.path)).toEqual(["after.sql", "removed.txt"]);
    expect(files[0].lines.slice(1).map((line) => line.text)).toEqual([
      "-- removed comment",
      "++ added expression",
    ]);
    expect(files[1].status).toBe("deleted");
    expect(files[1].lines.at(-1)?.noNewline).toBe(true);
  });
  test("sparse hunks preserve independent old/new coordinates and reject incomplete or overlapping ranges", () => {
    const patch = `${header}@@ -20,2 +40,2 @@\n context\n-old\n+new\n@@ -90,1 +100,1 @@\n-before\n+after\n`;
    const file = validateStoredPatch(patch)[0];
    expect(file.lines.filter((row) => row.type === "del").map((row) => row.oldLine)).toEqual([
      21, 90,
    ]);
    expect(file.lines.filter((row) => row.type === "add").map((row) => row.newLine)).toEqual([
      41, 100,
    ]);
    expect(() => validateStoredPatch(`${header}@@ -20,2 +40,2 @@\n-old\n+new\n`)).toThrow(
      "truncated",
    );
    expect(() => validateStoredPatch(`${header}@@ -20,1 +40,1 @@\n-old\n+new\n+extra\n`)).toThrow(
      "exceeds",
    );
    expect(() => validateStoredPatch(`${patch}@@ -20,1 +40,1 @@\n-a\n+b\n`)).toThrow("overlapping");
    expect(() => validateStoredPatch(`${patch}unexpected row\n`)).toThrow("Invalid patch hunk row");
    expect(() => validateStoredPatch(header)).toThrow("no changes");
  });

  test("binary markers, mode changes and empty-file creation remain publishable", () => {
    expect(
      validateStoredPatch(
        "diff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n",
      )[0].binary,
    ).toBe(true);
    expect(
      validateStoredPatch(
        "diff --git a/image.bin b/image.bin\nGIT binary patch\nliteral 0\nHcmV?d00001\n",
      )[0].binary,
    ).toBe(true);
    expect(
      validateStoredPatch("diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n"),
    ).toHaveLength(1);
    expect(
      validateStoredPatch(
        "diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n",
      )[0].status,
    ).toBe("added");
  });

  test("rendering and context expansion use only captured rows", async () => {
    const context = Array.from({ length: 12 }, (_, i) => ` line ${i + 1}`).join("\n");
    const patch = `${header}@@ -1,13 +1,13 @@\n${context}\n-before\n+after\n@@ -50,1 +60,1 @@\n-old\n+new\n`;
    const rendered = await renderStoredPatch(patch);
    expect(rendered[0].lines.length).toBeLessThan(validateStoredPatch(patch)[0].lines.length);
    const rows = await storedPatchContext(patch, "code.ts", 1, 3);
    expect(rows?.map((row) => row.text)).toEqual(["line 1", "line 2", "line 3"]);
    expect(await storedPatchContext(patch, "code.ts", 12, 14)).toBeNull();
    expect(await storedPatchContext(patch, "code.ts", 13, 60)).toBeNull();
    expect(await storedPatchContext(patch, "missing.ts", 1, 2)).toBeNull();
  });
});
