import { expect, test } from "bun:test";
import { ArtifactDemoBackend } from "./artifact-backend.ts";
import { bundledPreview, demoReference } from "./preview-fixtures.ts";

test("demo previews use only bundled bytes for a matching immutable publication", () => {
  const backend = new ArtifactDemoBackend();
  const stored = backend.publication("artifact_weekend", 1);
  stored.resources["index.html"] = btoa("<script>throw new Error('stored injection')</script>");
  const preview = bundledPreview(stored.version, "index.html")!;
  expect(preview.html).toContain("5 min read");
  expect(preview.html).not.toContain("stored injection");
  expect(preview.publication.resources["index.html"]).not.toEqual(stored.resources["index.html"]);
  expect(bundledPreview({ ...stored.version, contentHash: "changed" }, "index.html")).toBeNull();
  expect(bundledPreview({ ...stored.version, artifactId: "unknown" }, "index.html")).toBeNull();
  expect(bundledPreview({ ...stored.version, seq: 99 }, "index.html")).toBeNull();
  expect(bundledPreview(stored.version, "__proto__")).toBeNull();
  expect(bundledPreview(stored.version, "style.css")).toBeNull();
  const markdown = backend.publication("artifact_documents", 1);
  expect(bundledPreview(markdown.version, "index.md")?.html).toContain(
    '<h1 id="published-workspace">Published workspace</h1>',
  );
  backend.close();
});

test("demo document links and assets remain inside their publication", () => {
  expect(demoReference("nested/index.html", "../details.html#checklist")).toEqual({
    path: "details.html",
    route: "#checklist",
  });
  expect(demoReference("index.html", "#plan")).toEqual({ path: "index.html", route: "#plan" });
  for (const path of [
    "../escape",
    "%2e%2e/escape",
    "/outside",
    "//outside",
    "https://example.com",
    "data:text/html,test",
    "javascript:alert(1)",
    "?query",
    "bad\\path",
    "bad%00path",
    "%2foutside",
  ])
    expect(demoReference("index.html", path)).toBeNull();
});
