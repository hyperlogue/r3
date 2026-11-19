import type { BlobStore, StoredBlob } from "./blobs.ts";

export const HTML_PREVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS html_previews (
  artifact_id TEXT NOT NULL,
  version_seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  template_hash TEXT NOT NULL REFERENCES blobs(hash),
  url_offset INTEGER NOT NULL CHECK (url_offset >= 0),
  PRIMARY KEY (artifact_id, version_seq, path),
  FOREIGN KEY (artifact_id, version_seq, path)
    REFERENCES version_files(artifact_id, version_seq, path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS html_previews_by_template ON html_previews(template_hash);`;

export interface HtmlTemplate extends StoredBlob {
  urlOffset: number;
}

export async function prepareHtmlTemplate(bytes: Buffer, blobs: BlobStore): Promise<HtmlTemplate> {
  // The marker exists only during preparation. Its byte offset in the escaped
  // template lets the server splice in the scoped URL without scanning HTML.
  const marker = crypto.randomUUID();
  const imports = JSON.stringify({ imports: { "/r3/utility.js": marker } });
  const map = `<script type="importmap">${imports}</script>`;
  let injected = false;
  const source = await new HTMLRewriter()
    .on("*", {
      element(element) {
        if (injected || element.tagName === "html") return;
        injected = true;
        element.before(map, { html: true });
      },
    })
    .on("img", {
      element(image) {
        const src = image.getAttribute("src");
        const srcset = image.getAttribute("srcset");
        if (!srcset && (!src || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src.trim()))) return;
        // Hide authored candidates from the preload scanner until the workspace
        // can supply cached bytes. Preserve attribute entities for the HTML parser.
        for (const [name, value] of [
          ["src", src],
          ["srcset", srcset],
        ] as const) {
          if (value === null) continue;
          image.setAttribute(`data-r3-static-${name}`, value);
          image.removeAttribute(name);
        }
      },
    })
    .onDocument({
      end(end) {
        if (!injected) end.append(map, { html: true });
      },
    })
    .transform(new Response(new Uint8Array(bytes)))
    .text();
  const escaped = JSON.stringify(source).replaceAll("<", "\\u003c");
  const start = escaped.indexOf(marker);
  if (start < 0 || escaped.indexOf(marker, start + marker.length) !== -1)
    throw new Error("Invalid import map insertion point");
  const prefix = escaped.slice(0, start);
  const template = await blobs.put(prefix + escaped.slice(start + marker.length));
  return { ...template, urlOffset: Buffer.byteLength(prefix) };
}
