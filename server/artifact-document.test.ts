import { describe, expect, test } from "bun:test";
import { DOCUMENT_RENDERER_REVISION, renderArtifactDocument } from "./artifact-document.ts";

describe("retained Markdown documents", () => {
  test("local links, images and fragments retain ordinary document URL semantics", async () => {
    const source =
      "# Section\n\n[Next](../next.md#section)\n\n![Diagram](./diagram.svg)\n\n# Section\n";
    const result = await renderArtifactDocument(source, "docs/index.md");
    expect(result.revision).toBe(DOCUMENT_RENDERER_REVISION);
    expect(result.html).toContain('href="../next.md#section"');
    expect(result.html).toContain('src="./diagram.svg"');
    expect(result.html).toContain('id="section"');
    expect(result.html).toContain('id="section-1"');
    expect(result.html).not.toContain("data-line-start");
    expect(result.html).not.toContain("r3-doclink");
  });

  test("published prose escapes raw HTML and preserves code highlighting and safe diagrams", async () => {
    const result = await renderArtifactDocument(
      '<script>alert("no")</script>\n\n```ts\nconst answer = 42;\n```\n\n```mermaid\ngraph TD\n  A[Hello] --> B[World]\n```',
      "index.md",
    );
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain('class="shiki-code language-ts"');
    expect(result.html).toContain("<svg");
    expect(result.html).not.toContain("data-line-start");
  });
});
